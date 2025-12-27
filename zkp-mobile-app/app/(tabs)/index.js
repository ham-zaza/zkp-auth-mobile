import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Alert } from 'react-native';
import { CameraView, Camera } from "expo-camera";
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import { io } from 'socket.io-client';
import * as SecureStore from 'expo-secure-store';
import * as OTPAuth from "otpauth";
import * as Crypto from 'expo-crypto';
import { CryptoService } from '../../cryptoService';

// ⚠️ CONFIRM YOUR PC IP ADDRESS
const PC_IP = "192.168.100.187";
const BACKEND_URL = `http://${PC_IP}:3000`;
const MOBILE_USERNAME = "MobileUser";

export default function App() {
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
        if (savedSecret) setTotpSecret(savedSecret);
        else setTotpSecret(null);
    };

    // 3. TOTP Timer
    useEffect(() => {
        if (!totpSecret) return;
        const interval = setInterval(() => {
            const totp = new OTPAuth.TOTP({
                issuer: "ZK-Auth",
                label: MOBILE_USERNAME,
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
        try {
            setStatus("⏳ Registering...");
            const secretX = await CryptoService.getOrGenerateSecret();
            const keys = await CryptoService.getPublicKeys(secretX);
            const newTotpSecret = await generateBase32Secret();

            const response = await fetch(`${BACKEND_URL}/api/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: MOBILE_USERNAME,
                    publicKeyY: keys.y,
                    publicKeyZ: keys.z,
                    totpSecret: newTotpSecret
                })
            });

            if (response.ok) {
                await SecureStore.setItemAsync('totp_secret', newTotpSecret);
                setTotpSecret(newTotpSecret);
                Alert.alert("✅ Success", "Device Registered!");
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
        await SecureStore.deleteItemAsync('totp_secret');
        setTotpSecret(null);
        setTotpCode("--- ---");
        setStatus("App Reset. Please Register again.");
        Alert.alert("Reset Complete", "You can now register this device again.");
    };

    // 7. SCAN LOGIC
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
                body: JSON.stringify({ username: MOBILE_USERNAME, ...proof })
            });

            if (!response.ok) {
                if (response.status === 404) throw new Error("User not found on Server. Please Reset App & Register.");
                throw new Error("Login Failed");
            }

            if (socket) socket.emit('mobile_authenticated', { sessionId: qrData.sessionId, username: MOBILE_USERNAME });

            setStatus("✅ PC Unlocked!");
            Alert.alert("Success", "PC Unlocked!");

        } catch (error) {
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
                    <Text style={styles.totpLabel}>Backup Code</Text>
                    <Text style={styles.totpCode}>{totpCode}</Text>
                    <View style={styles.timerBar}>
                        <View style={{...styles.timerFill, width: `${(timeLeft/30)*100}%`}} />
                    </View>
                    <TouchableOpacity onPress={handleReset} style={styles.resetLink}>
                        <Text style={styles.resetText}>⚠ Reset / Re-Register App</Text>
                    </TouchableOpacity>
                </View>
            ) : (
                !scanned && (
                    <TouchableOpacity style={styles.regButton} onPress={handleManualRegister}>
                        <Text style={styles.buttonText}>📝 Register Device</Text>
                    </TouchableOpacity>
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
    container: { flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center', padding: 20 },
    title: { color: '#3b82f6', fontSize: 24, fontWeight: 'bold', marginBottom: 20 },
    text: { color: '#fff' },
    cameraContainer: { width: 260, height: 260, borderRadius: 20, overflow: 'hidden', borderWidth: 2, borderColor: '#3b82f6', marginBottom: 15 },
    status: { color: '#94a3b8', fontSize: 14, textAlign: 'center', marginBottom: 15, fontWeight: '500', height: 20 },
    statusActive: { color: '#4ade80' },
    button: { backgroundColor: '#3b82f6', paddingVertical: 12, paddingHorizontal: 30, borderRadius: 8, marginTop: 10 },
    regButton: { backgroundColor: '#10b981', paddingVertical: 12, paddingHorizontal: 30, borderRadius: 8, marginTop: 10 },
    buttonText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
    totpContainer: { marginTop: 10, alignItems: 'center', backgroundColor: '#1e293b', padding: 15, borderRadius: 12, width: '100%' },
    totpLabel: { color: '#94a3b8', fontSize: 12, textTransform: 'uppercase', marginBottom: 5 },
    totpCode: { color: '#fff', fontSize: 32, fontFamily: 'monospace', fontWeight: 'bold', letterSpacing: 2 },
    timerBar: { height: 4, width: '100%', backgroundColor: '#334155', borderRadius: 2, marginTop: 10, overflow: 'hidden' },
    timerFill: { height: '100%', backgroundColor: '#3b82f6' },
    resetLink: { marginTop: 20, padding: 10 },
    resetText: { color: '#ef4444', fontSize: 12, fontWeight: 'bold' }
});
