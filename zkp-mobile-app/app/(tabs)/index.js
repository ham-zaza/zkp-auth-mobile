import React, { useState, useEffect } from 'react';
import { CameraView, Camera } from "expo-camera";
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import { io } from 'socket.io-client';
import * as SecureStore from 'expo-secure-store';
import * as OTPAuth from "otpauth";
import * as Crypto from 'expo-crypto';
import { CryptoService } from '../../cryptoService';
import { StyleSheet, Text, View, TouchableOpacity, Alert, TextInput } from 'react-native'; // <-- Added TextInput

// ⚠️ CONFIRM YOUR PC IP ADDRESS
const PC_IP = "192.168.100.10";
const BACKEND_URL = `http://${PC_IP}:3000`;
// const MOBILE_USERNAME = "MobileUser";

export default function App() {
    const [username, setUsername] = useState("");
    const [isRegistered, setIsRegistered] = useState(false); // To track if we should show input or not
    const [hasPermission, setHasPermission] = useState(null);
    const [scanned, setScanned] = useState(false);
    const [status, setStatus] = useState("Ready");
    const [socket, setSocket] = useState(null);

    // TOTP State
    const [totpSecret, setTotpSecret] = useState(null);
    const [totpCode, setTotpCode] = useState("--- ---");
    const [timeLeft, setTimeLeft] = useState(30);

    // 1. Setup
    useEffect(() => {
        const setup = async () => {
            const { status } = await Camera.requestCameraPermissionsAsync();
            setHasPermission(status === "granted");

            console.log(`Connecting to ${BACKEND_URL}...`);
            const newSocket = io(BACKEND_URL);
            setSocket(newSocket);

            newSocket.on('connect', () => setStatus("Connected to PC"));
            newSocket.on('connect_error', () => setStatus("Connection Failed - Check IP"));

            checkRegistration();
        };
        setup();
    }, []);

    // 2. Check if already registered
    const checkRegistration = async () => {
        const savedSecret = await SecureStore.getItemAsync('totp_secret');
        const savedName = await SecureStore.getItemAsync('mobile_username');
        if (savedSecret && savedName) {
            setTotpSecret(savedSecret);
            setUsername(savedName); // Restore the name
            setIsRegistered(true);
        } else {
            setTotpSecret(null);
            setIsRegistered(false);
        }
    };

    // 3. TOTP Timer
    useEffect(() => {
        if (!totpSecret) return;
        const interval = setInterval(() => {
            const totp = new OTPAuth.TOTP({
                issuer: "ZK-Auth",
                label: username,
                algorithm: "SHA1",
                digits: 6,
                period: 30,
                secret: OTPAuth.Secret.fromBase32(totpSecret)
            });
            const code = totp.generate();
            setTotpCode(code.slice(0,3) + " " + code.slice(3));
            const epoch = Math.floor(Date.now() / 1000);
            setTimeLeft(30 - (epoch % 30));
        }, 1000);
        return () => clearInterval(interval);
    }, [totpSecret]);

    // 4. Generate Random Base32 Secret
    const generateBase32Secret = async () => {
        const randomBytes = await Crypto.getRandomBytesAsync(20);
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let output = '';
        for (let i = 0; i < randomBytes.length; i++) output += alphabet[randomBytes[i] % 32];
        return output;
    };

    // 5. MANUAL REGISTER
    const handleManualRegister = async () => {
        if (!username.trim()) {
            Alert.alert("Error", "Please enter a unique username");
            return;
        }
        try {
            setStatus("⏳ Registering...");
            const secretX = await CryptoService.getOrGenerateSecret();
            const keys = await CryptoService.getPublicKeys(secretX);
            const newTotpSecret = await generateBase32Secret();

            const response = await fetch(`${BACKEND_URL}/api/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: username,
                    publicKeyY: keys.y,
                    publicKeyZ: keys.z,
                    totpSecret: newTotpSecret
                })
            });

            if (response.ok) {
                await SecureStore.setItemAsync('totp_secret', newTotpSecret);
                await SecureStore.setItemAsync('mobile_username', username);
                setTotpSecret(newTotpSecret);
                setIsRegistered(true);
                Alert.alert("✅ Success", `Device Registered as ${username}!`);
                setStatus("Registered! Ready to Scan.");
            } else {
                const err = await response.json();
                throw new Error(err.message || "Server rejected");
            }
        } catch (e) {
            Alert.alert("Error", e.message);
            setStatus("Registration Failed");
        }
    };

    // 6. RESET APP (Clear Data)
    const handleReset = async () => {
        try {
            // 1. Delete the TOTP Secret (The Backup Code)
            await SecureStore.deleteItemAsync('totp_secret');

            // 2. Delete the ZK Private Key (The Identity)
            await SecureStore.deleteItemAsync('zkp_secret_v1');

            // 3. Deletes Name
            await SecureStore.deleteItemAsync('mobile_username');

            // 4. Reset Local State
            setTotpSecret(null);
            setTotpCode("--- ---");
            setIsRegistered(false);
            setUsername(""); // Clear input
            setStatus("App Reset. Please Register again.");

            Alert.alert(
                "Identity Wiped",
                "Your cryptographic keys have been destroyed. You can now register as a fresh device."
            );
        } catch (e) {
            console.error(e);
            Alert.alert("Reset Error", "Could not fully wipe data.");
        }
    };

    // 7. SCAN LOGIC (FIXED FOR PROTOCOL 6)
    const handleBarCodeScanned = async ({ type, data }) => {
        if (scanned) return;
        setScanned(true);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        try {
            let qrData;
            try { qrData = JSON.parse(data); } catch (e) { throw new Error("Invalid QR"); }
            if (!qrData.sessionId) throw new Error("No Session ID");

            setStatus("Verifying Biometrics...");
            const bioAuth = await LocalAuthentication.authenticateAsync({
                promptMessage: 'Login to PC',
                disableDeviceFallback: false,
            });
            if (!bioAuth.success) throw new Error("Biometrics cancelled");

            setStatus("Generating Proof...");
            const secretX = await CryptoService.getOrGenerateSecret();
            const proof = await CryptoService.generateProof(secretX, qrData.sessionId);

            setStatus("Sending Proof...");
            const response = await fetch(`${BACKEND_URL}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username, ...proof })
            });

            // 🛑 CHECK RESPONSE CAREFULLY
            if (!response.ok) {
                // Try to read the error message from the server
                let errorMessage = "Login Failed";
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.message || errorMessage;
                } catch (e) { /* No JSON body */ }

                console.log("Server Error:", response.status, errorMessage);

                // TRIGGER WIPE CONDITIONS:
                // 1. Status is 404 (Not Found)
                // 2. OR The message says "User not found" / "not exist"
                if (response.status === 404 ||
                    response.status === 500 ||
                    errorMessage.toLowerCase().includes("not found") ||
                    errorMessage.toLowerCase().includes("exist") ||
                    errorMessage.toLowerCase().includes("calculation error")) {
                    throw new Error("PROTOCOL_6_WIPE");
                }

                throw new Error(errorMessage);
            }

            if (socket) socket.emit('mobile_authenticated', { sessionId: qrData.sessionId, username: username });

            setStatus("✅ PC Unlocked!");
            Alert.alert("Success", "PC Unlocked!");

        } catch (error) {
            console.log("Catch Error:", error.message);

            // 🛑 THE MAGIC HAPPENS HERE
            if (error.message === "PROTOCOL_6_WIPE") {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                Alert.alert(
                    "⛔ IDENTITY TERMINATED",
                    "Security Alert: This identity was burnt on the terminal. The keys are no longer valid.\n\nInitiating Safety Wipe...",
                    [
                        {
                            text: "Wipe Device Now",
                            onPress: async () => {
                                await handleReset(); // Calls your existing reset function
                            },
                            style: "destructive"
                        }
                    ]
                );
                return; // Stop here, don't show the normal error
            }

            setStatus("❌ " + error.message);
            Alert.alert("Login Error", error.message);
        }

        setTimeout(() => { setScanned(false); setStatus("Ready to Scan"); }, 4000);
    };

    if (hasPermission === null) return <View style={styles.container}><Text style={styles.text}>Requesting permission...</Text></View>;
    if (hasPermission === false) return <View style={styles.container}><Text style={styles.text}>No access to camera</Text></View>;

    return (
        <View style={styles.container}>
            <Text style={styles.title}>ZK-Authenticator</Text>

            {/* CAMERA SECTION */}
            <View style={styles.cameraContainer}>
                <CameraView
                    onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
                    barcodeScannerSettings={{ barcodeTypes: ["qr", "pdf417"] }}
                    style={StyleSheet.absoluteFillObject}
                />
            </View>

            <Text style={[styles.status, scanned && styles.statusActive]}>{status}</Text>

            {/* DYNAMIC CONTENT: TOTP OR REGISTER */}
            {totpSecret ? (
                <View style={styles.totpContainer}>
                    <View style={styles.secureBadge}>
                        <Text style={styles.secureText}>ENCRYPTED VAULT</Text>
                    </View>

                    <Text style={styles.totpLabel}>Identity Backup Code</Text>

                    {/* Display the Username clearly */}
                    <Text style={{color: '#94a3b8', fontSize: 14, marginBottom: 10}}>
                        User: <Text style={{color: '#fff', fontWeight: 'bold'}}>{username}</Text>
                    </Text>

                    {/* Digital Clock Style Code */}
                    <Text style={styles.totpCode}>{totpCode}</Text>

                    {/* Dynamic Color Progress Bar */}
                    <View style={styles.timerBar}>
                        <View style={{
                            ...styles.timerFill,
                            width: `${(timeLeft/30)*100}%`,
                            backgroundColor: timeLeft < 6 ? '#ef4444' : timeLeft < 15 ? '#f59e0b' : '#10b981'
                        }} />
                    </View>
                    <Text style={{color: '#64748b', fontSize: 10, marginTop: 5, fontFamily: 'monospace'}}>
                        Expires in {timeLeft}s
                    </Text>

                    <TouchableOpacity onPress={handleReset} style={styles.resetLink}>
                        <Text style={styles.resetText}>⚠ UNLINK DEVICE</Text>
                    </TouchableOpacity>
                </View>
            ) : (
                !scanned && (
                    <View style={{width: '100%', alignItems: 'center'}}>
                        {/* NEW INPUT FIELD */}
                        <TextInput
                            style={styles.input}
                            placeholder="Enter Unique Username"
                            placeholderTextColor="#64748b"
                            value={username}
                            onChangeText={setUsername}
                            autoCapitalize="none"
                        />
                        <TouchableOpacity style={styles.regButton} onPress={handleManualRegister}>
                            <Text style={styles.buttonText}>📝 Register Device</Text>
                        </TouchableOpacity>
                    </View>
                )
            )}

            {scanned && (
                <TouchableOpacity style={styles.button} onPress={() => setScanned(false)}>
                    <Text style={styles.buttonText}>Scan Again</Text>
                </TouchableOpacity>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    input: {
        backgroundColor: '#1e293b',
        width: '100%',
        padding: 15,
        borderRadius: 12,
        color: '#fff',
        borderWidth: 1,
        borderColor: '#334155',
        marginBottom: 10,
        textAlign: 'center',
        fontSize: 16
    },
    container: { flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center', padding: 20 },
    title: { color: '#3b82f6', fontSize: 24, fontWeight: 'bold', marginBottom: 20 },
    text: { color: '#fff' },
    cameraContainer: {
        width: 260, height: 260, borderRadius: 24, overflow: 'hidden',
        borderWidth: 3, borderColor: '#3b82f6', marginBottom: 20,
        shadowColor: "#3b82f6", shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.4, shadowRadius: 20
    },

    status: { color: '#94a3b8', fontSize: 13, textAlign: 'center', marginBottom: 20, fontWeight: '600', height: 20, textTransform: 'uppercase', letterSpacing: 1 },
    statusActive: { color: '#4ade80' },
    button: { backgroundColor: '#3b82f6', paddingVertical: 14, paddingHorizontal: 30, borderRadius: 12, marginTop: 10, width: '100%', alignItems: 'center' },
    regButton: { backgroundColor: '#10b981', paddingVertical: 14, paddingHorizontal: 30, borderRadius: 12, marginTop: 10, width: '100%', alignItems: 'center' },
    buttonText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },

    totpContainer: {
        marginTop: 10, alignItems: 'center', backgroundColor: '#1e293b',
        paddingVertical: 25, paddingHorizontal: 20, borderRadius: 20, width: '100%',
        borderWidth: 1, borderColor: '#334155',
        shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 5
    },
    secureBadge: { backgroundColor: '#0f172a', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, marginBottom: 15, borderWidth: 1, borderColor: '#3b82f6' },
    secureText: { color: '#3b82f6', fontSize: 10, fontWeight: 'bold', letterSpacing: 1 },

    totpLabel: { color: '#64748b', fontSize: 12, textTransform: 'uppercase', marginBottom: 8, fontWeight: '600' },

    totpCode: {
        color: '#f1f5f9', fontSize: 36, fontFamily: 'monospace', fontWeight: 'bold', letterSpacing: 4,
        textShadowColor: 'rgba(255, 255, 255, 0.2)', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 10
    },

    timerBar: { height: 6, width: '100%', backgroundColor: '#0f172a', borderRadius: 3, marginTop: 15, overflow: 'hidden' },
    timerFill: { height: '100%', borderRadius: 3 }, // Background color is now handled inline in the JSX

    resetLink: { marginTop: 25, padding: 10, opacity: 0.8 },
    resetText: { color: '#ef4444', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 1 }
});
