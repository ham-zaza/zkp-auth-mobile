// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Alert, TextInput, Keyboard, TouchableWithoutFeedback } from 'react-native';
import { CameraView, Camera } from "expo-camera";
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import { io } from 'socket.io-client';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { CryptoService } from '../../cryptoService';

// 🌍 PUBLIC CLOUD UPLINK (Ngrok)
const BACKEND_URL = `https://eliz-nonrefracting-rosendo.ngrok-free.dev`;

export default function App() {
    const [username, setUsername] = useState("");
    const [isRegistered, setIsRegistered] = useState(false);
    const [hasPermission, setHasPermission] = useState(null);
    const [scanned, setScanned] = useState(false);
    const [status, setStatus] = useState("Initializing...");
    const [pukKey, setPukKey] = useState(null);

    const socketRef = useRef(null);

    // 1. SETUP
    useEffect(() => {
        let active = true;
        const setup = async () => {
            const { status } = await Camera.requestCameraPermissionsAsync();
            if (!active) return;
            setHasPermission(status === "granted");

            const sock = io(BACKEND_URL, { transports: ['websocket'],
                extraHeaders: {
                    "ngrok-skip-browser-warning": "true"
                } });
            socketRef.current = sock;

            sock.on('connect', () => setStatus("Connected to System"));
            sock.on('connect_error', () => setStatus("Offline - Check IP"));

            await checkRegistration();
        };
        setup();
        return () => {
            active = false;
            if (socketRef.current) socketRef.current.disconnect();
        };
    }, []);

    // 2. CHECK REGISTRATION
    const checkRegistration = async () => {
        try {
            const savedPuk = await SecureStore.getItemAsync('puk_key');
            const savedName = await SecureStore.getItemAsync('mobile_username');

            if (savedPuk && savedName) {
                setPukKey(savedPuk);
                setUsername(savedName);
                setIsRegistered(true);
                setStatus("Ready to Scan");
            } else {
                setIsRegistered(false);
                setStatus("Setup Required");
            }
        } catch {
            setStatus("Storage Error");
        }
    };

    // 3. REGISTER DEVICE (Old UI Logic + Readable PUK)
    const handleManualRegister = async () => {
        if (!username.trim()) {
            Alert.alert("Error", "Username required");
            return;
        }
        Keyboard.dismiss();

        try {
            setStatus("Generating Identity...");

            // ZKP Keys
            const secretX = await CryptoService.getOrGenerateSecret();
            const keys = await CryptoService.getPublicKeys(secretX);

            // 🔥 READABLE PUK LOGIC (Better for Hard Reset)
            const cleanUser = username.trim().toUpperCase().replace(/\s/g, '');
            const generatedPuk = `ZK-${cleanUser}-001`;

            const response = await fetch(`${BACKEND_URL}/api/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': 'true' },
                body: JSON.stringify({
                    username: username,
                    publicKeyY: keys.y,
                    publicKeyZ: keys.z
                })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.message || "Server rejected");
            }

            await SecureStore.setItemAsync('puk_key', generatedPuk);
            await SecureStore.setItemAsync('mobile_username', username);

            setPukKey(generatedPuk);
            setIsRegistered(true);
            setStatus("Ready to Scan");

            Alert.alert("Device Paired", `Identity: ${username}\nPUK stored in Vault.`);

        } catch (e) {
            setStatus("Registration Failed");
            Alert.alert("Registration Failed", e.message);
        }
    };

    // 4. WIPE
    const handleReset = async () => {
        Alert.alert("Unlink Device?", "This will remove your identity.", [
            { text: "Cancel", style: "cancel" },
            {
                text: "Unlink & Delete",
                style: "destructive",
                onPress: async () => {
                    try {
                        // 1. Attempt to delete from Server
                        // We use the current state 'username'
                        if (username) {
                            await fetch(`${BACKEND_URL}/api/delete-user`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': 'true' },
                                body: JSON.stringify({ username })
                            });
                        }
                    } catch (e) {
                        // If server is down, we don't care. We must wipe local data anyway.
                        console.log("Server cleanup failed (Offline?), proceeding to local wipe.");
                    }

                    // 2. Wipe Local Secure Storage
                    await SecureStore.deleteItemAsync('puk_key');
                    await SecureStore.deleteItemAsync('zkp_secret_v1');
                    await SecureStore.deleteItemAsync('mobile_username');

                    // 3. Reset State
                    setPukKey(null);
                    setUsername("");
                    setIsRegistered(false);
                    setStatus("Identity Wiped");

                    Alert.alert("Device Unlinked", "Identity removed from Device & Server.");
                }
            }
        ]);
    };

    // 5. SCAN LOGIC (Syncs PUK Hash to PC)
    const handleBarCodeScanned = async ({ data }) => {
        if (scanned) return;
        setScanned(true);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        try {
            const qrData = JSON.parse(data);

            // 🔵 REMOTE UNLOCK + SYNC HANDSHAKE
            if (qrData.type === 'remote_unlock' && qrData.targetSocketId) {

                const bio = await LocalAuthentication.authenticateAsync({
                    promptMessage: 'Confirm Remote Unlock'
                });
                if (!bio.success) throw new Error("Biometric rejected");

                // Hash the PUK before sending (Security Best Practice)
                const pukHash = await Crypto.digestStringAsync(
                    Crypto.CryptoDigestAlgorithm.SHA256,
                    pukKey
                );

                socketRef.current.emit('force_unlock_pc', {
                    targetSocketId: qrData.targetSocketId,
                    pukHash,
                    username: username
                });

                setStatus("PC Unlocked & Synced");
                Alert.alert("Success", "PC unlocked & Identity Synced");
                return;
            }

            // 🔵 ZKP LOGIN
            if (!qrData.sessionId) throw new Error("Invalid QR");

            const bio = await LocalAuthentication.authenticateAsync({
                promptMessage: 'Authorize Login'
            });
            if (!bio.success) throw new Error("Biometric rejected");

            const secretX = await CryptoService.getOrGenerateSecret();
            const proof = await CryptoService.generateProof(secretX, qrData.sessionId);

            const response = await fetch(`${BACKEND_URL}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': 'true' },
                body: JSON.stringify({ username, ...proof })
            });

            if (!response.ok) throw new Error("Login failed");

            socketRef.current.emit('mobile_authenticated', {
                sessionId: qrData.sessionId,
                username
            });

            setStatus("Login Successful");
            Alert.alert("Access Granted");

        } catch (e) {
            setStatus("❌ " + e.message);
            Alert.alert("Scan Error", e.message);
        } finally {
            setTimeout(() => {
                setScanned(false);
                setStatus("Ready to Scan");
            }, 3000);
        }
    };

    // UI RENDERING
    if (hasPermission === null) return <View style={styles.center}><Text style={styles.text}>Requesting permissions...</Text></View>;
    if (hasPermission === false) return <View style={styles.center}><Text style={styles.text}>No camera access</Text></View>;

    return (
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <View style={styles.container}>
                <Text style={styles.title}>ZK-Authenticator</Text>

                {/* --- 1. OLD REGISTRATION UI --- */}
                {!isRegistered && (
                    <View style={{width: '100%', alignItems: 'center'}}>
                        <TextInput
                            style={styles.input}
                            placeholder="Enter Username"
                            placeholderTextColor="#64748b"
                            value={username}
                            onChangeText={setUsername}
                            autoCapitalize="none"
                        />
                        <TouchableOpacity style={styles.regButton} onPress={handleManualRegister}>
                            <Text style={styles.buttonText}>📝 Register Device</Text>
                        </TouchableOpacity>
                        <Text style={[styles.status, {marginTop: 20}]}>{status}</Text>
                    </View>
                )}

                {/* --- 2. SCANNER UI --- */}
                {isRegistered && (
                    <>
                        <View style={styles.cameraContainer}>
                            <CameraView
                                onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
                                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                                style={StyleSheet.absoluteFillObject}
                            />
                        </View>

                        <Text style={[styles.status, scanned && styles.statusActive]}>{status}</Text>

                        {/* Info Card (Replaces TOTP Box) */}
                        <View style={styles.totpContainer}>
                            <View style={styles.secureBadge}>
                                <Text style={styles.secureText}>ACTIVE IDENTITY</Text>
                            </View>
                            <Text style={styles.totpCode}>{username}</Text>
                            <Text style={{color: '#64748b', fontSize: 10, marginTop: 5}}>PUK Securely Stored in Vault</Text>

                            <TouchableOpacity onPress={handleReset} style={styles.resetLink}>
                                <Text style={styles.resetText}>⚠ UNLINK DEVICE</Text>
                            </TouchableOpacity>
                        </View>
                    </>
                )}

                {scanned && (
                    <TouchableOpacity style={styles.button} onPress={() => setScanned(false)}>
                        <Text style={styles.buttonText}>Scan Again</Text>
                    </TouchableOpacity>
                )}
            </View>
        </TouchableWithoutFeedback>
    );
}

const styles = StyleSheet.create({
    center: { flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center' },
    container: { flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center', padding: 20 },
    title: { color: '#3b82f6', fontSize: 24, fontWeight: 'bold', marginBottom: 20 },
    text: { color: '#fff' },

    // OLD STYLE CAMERA (Blue Border)
    cameraContainer: {
        width: 260, height: 260, borderRadius: 24, overflow: 'hidden',
        borderWidth: 3, borderColor: '#3b82f6', marginBottom: 20,
        shadowColor: "#3b82f6", shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.4, shadowRadius: 20
    },

    status: { color: '#94a3b8', fontSize: 13, textAlign: 'center', marginBottom: 20, fontWeight: '600', height: 20, textTransform: 'uppercase', letterSpacing: 1 },
    statusActive: { color: '#4ade80' },

    // OLD STYLE BUTTONS & INPUTS
    input: { backgroundColor: '#1e293b', width: '100%', padding: 15, borderRadius: 12, color: '#fff', borderWidth: 1, borderColor: '#334155', marginBottom: 10, textAlign: 'center', fontSize: 16 },
    button: { backgroundColor: '#3b82f6', paddingVertical: 14, paddingHorizontal: 30, borderRadius: 12, marginTop: 10, width: '100%', alignItems: 'center' },
    regButton: { backgroundColor: '#10b981', paddingVertical: 14, paddingHorizontal: 30, borderRadius: 12, marginTop: 10, width: '100%', alignItems: 'center' },
    buttonText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },

    // CARD STYLE (Matches your old TOTP box)
    totpContainer: {
        marginTop: 10, alignItems: 'center', backgroundColor: '#1e293b',
        paddingVertical: 25, paddingHorizontal: 20, borderRadius: 20, width: '100%',
        borderWidth: 1, borderColor: '#334155',
        shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 5
    },
    secureBadge: { backgroundColor: '#0f172a', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, marginBottom: 15, borderWidth: 1, borderColor: '#3b82f6' },
    secureText: { color: '#3b82f6', fontSize: 10, fontWeight: 'bold', letterSpacing: 1 },
    totpCode: { color: '#f1f5f9', fontSize: 24, fontWeight: 'bold', letterSpacing: 1 },

    resetLink: { marginTop: 25, padding: 10, opacity: 0.8 },
    resetText: { color: '#ef4444', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 1 }
});