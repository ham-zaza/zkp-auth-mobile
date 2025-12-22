import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Alert } from 'react-native';
import { CameraView, Camera } from "expo-camera";
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import { io } from 'socket.io-client';
import { CryptoService } from '../../cryptoService';

// ⚠️ DOUBLE CHECK YOUR IP ADDRESS IF CONNECTION FAILS
const PC_IP = "192.168.100.10";
const BACKEND_URL = `http://${PC_IP}:3000`;
const MOBILE_USERNAME = "MobileUser";

export default function App() {
    const [hasPermission, setHasPermission] = useState(null);
    const [scanned, setScanned] = useState(false);
    const [status, setStatus] = useState("Ready");
    const [socket, setSocket] = useState(null);

    useEffect(() => {
        const setup = async () => {
            const { status } = await Camera.requestCameraPermissionsAsync();
            setHasPermission(status === "granted");

            console.log(`Connecting to ${BACKEND_URL}...`);
            const newSocket = io(BACKEND_URL);
            setSocket(newSocket);

            newSocket.on('connect', () => setStatus("Connected to PC"));
            newSocket.on('connect_error', () => setStatus("Connection Failed - Check IP"));
        };
        setup();
    }, []);

    // --- MANUAL REGISTER FUNCTION ---
    const handleManualRegister = async () => {
        try {
            if (!CryptoService.getPublicKeys) {
                throw new Error("CryptoService outdated! Update cryptoService.js file.");
            }

            setStatus("⏳ Registering...");
            const secretX = await CryptoService.getOrGenerateSecret();
            const keys = await CryptoService.getPublicKeys(secretX);

            const response = await fetch(`${BACKEND_URL}/api/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: MOBILE_USERNAME,
                    publicKeyY: keys.y,
                    publicKeyZ: keys.z
                })
            });

            if (response.ok) {
                Alert.alert("✅ Success", "Device Registered! Now Scan QR to Login.");
                setStatus("Registered! Ready to Scan.");
            } else {
                const err = await response.json();
                throw new Error(err.message || "Server rejected registration");
            }
        } catch (e) {
            Alert.alert("Registration Error", e.message);
            setStatus("Registration Failed");
        }
    };

    // --- LOGIN SCAN FUNCTION ---
    const handleBarCodeScanned = async ({ type, data }) => {
        if (scanned) return;
        setScanned(true);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setStatus("Verifying Biometrics...");

        try {
            let qrData;
            try { qrData = JSON.parse(data); } catch (e) { throw new Error("Invalid QR Code"); }
            if (!qrData.sessionId) throw new Error("No Session ID found");

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
                const err = await response.json();
                if (response.status === 404) {
                    throw new Error("User not found. Please click 'Register Device' first.");
                }
                throw new Error(err.message || "Login Failed");
            }

            // Unlock PC via Socket
            if (socket) {
                socket.emit('mobile_authenticated', {
                    sessionId: qrData.sessionId,
                    username: MOBILE_USERNAME
                });
            }

            setStatus("✅ Browser Unlocked!");
            Alert.alert("Success", "You are logged in!");

        } catch (error) {
            setStatus("❌ " + error.message);
            Alert.alert("Error", error.message);
        }

        setTimeout(() => { setScanned(false); setStatus("Ready to Scan"); }, 4000);
    };

    if (hasPermission === null) return <View style={styles.container}><Text style={styles.text}>Requesting permission...</Text></View>;
    if (hasPermission === false) return <View style={styles.container}><Text style={styles.text}>No access to camera</Text></View>;

    return (
        <View style={styles.container}>
            <Text style={styles.title}>ZK-Authenticator</Text>

            {/* CAMERA */}
            <View style={styles.cameraContainer}>
                <CameraView
                    onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
                    barcodeScannerSettings={{ barcodeTypes: ["qr", "pdf417"] }}
                    style={StyleSheet.absoluteFillObject}
                />
                {/* Overlay */}
                <View style={styles.overlay}>
                    <View style={styles.unfocusedContainer}></View>
                    <View style={styles.middleContainer}>
                        <View style={styles.unfocusedContainer}></View>
                        <View style={styles.focusedContainer}></View>
                        <View style={styles.unfocusedContainer}></View>
                    </View>
                    <View style={styles.unfocusedContainer}></View>
                </View>
            </View>

            <Text style={[styles.status, scanned && styles.statusActive]}>{status}</Text>

            {/* NEW REGISTER BUTTON */}
            {!scanned && (
                <TouchableOpacity style={styles.regButton} onPress={handleManualRegister}>
                    <Text style={styles.buttonText}>📝 Register Device</Text>
                </TouchableOpacity>
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
    title: { color: '#3b82f6', fontSize: 28, fontWeight: 'bold', marginBottom: 20, letterSpacing: 1 },
    text: { color: '#fff' },
    cameraContainer: { width: 280, height: 280, borderRadius: 20, overflow: 'hidden', borderWidth: 2, borderColor: '#3b82f6', marginBottom: 20 },
    status: { color: '#94a3b8', fontSize: 16, textAlign: 'center', marginBottom: 20, fontWeight: '500', height: 20 },
    statusActive: { color: '#4ade80' },
    button: { backgroundColor: '#3b82f6', paddingVertical: 12, paddingHorizontal: 30, borderRadius: 8, marginTop: 10 },
    regButton: { backgroundColor: '#10b981', paddingVertical: 12, paddingHorizontal: 30, borderRadius: 8, marginTop: 10 },
    buttonText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
    overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    unfocusedContainer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
    middleContainer: { flexDirection: 'row', flex: 1.5 },
    focusedContainer: { flex: 10 },
});