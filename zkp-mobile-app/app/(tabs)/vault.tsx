// @ts-nocheck
import React, { useState, useEffect } from 'react';
import {
    StyleSheet, View, Text, TouchableOpacity, Alert, Platform,
    ActivityIndicator, ScrollView, LayoutAnimation, UIManager
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function VaultScreen() {
    const [expandedId, setExpandedId] = useState(null);
    const [pukCode, setPukCode] = useState(null);
    const [isRevealed, setIsRevealed] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        initializePUK();
    }, []);

    const initializePUK = async () => {
        try {
            const storedPuk = await SecureStore.getItemAsync('puk_key');
            if (storedPuk) {
                setPukCode(storedPuk);
            } else {
                setPukCode("SETUP REQUIRED");
            }
        } catch (e) {
            console.log("Storage Error:", e);
        } finally {
            setLoading(false);
        }
    };

    const toggleItem = (id) => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setExpandedId(expandedId === id ? null : id);
    };

    const handleRevealCode = async () => {
        if (pukCode === "SETUP REQUIRED") {
            Alert.alert("Identity Missing", "Register device first.");
            return;
        }

        if (isRevealed) { setIsRevealed(false); return; }

        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        if (!hasHardware) {
            // Fallback for simulators
            setIsRevealed(true);
            setTimeout(() => setIsRevealed(false), 10000);
            return;
        }

        const result = await LocalAuthentication.authenticateAsync({
            promptMessage: 'Unlock Security Vault',
            fallbackLabel: 'Enter Passcode',
        });

        if (result.success) {
            setIsRevealed(true);
            setTimeout(() => setIsRevealed(false), 10000);
        }
    };

    const handleRemoteUnlock = () => {
        Alert.alert(
            "Remote Unlock",
            "Scan the emergency QR on PC to force unlock.",
            [
                { text: "Cancel", style: "cancel" },
                { text: "Open Scanner", onPress: () => router.push('/') }
            ]
        );
    };

    if (loading) return <View style={styles.center}><ActivityIndicator color="#10b981" /></View>;

    return (
        <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 150 }}>
            <View style={styles.header}>
                <View style={styles.headerIconBg}>
                    <Ionicons name="shield-checkmark" size={32} color="#10b981" />
                </View>
                <View>
                    <Text style={styles.headerTitle}>SECURITY VAULT</Text>
                    <Text style={styles.headerSubtitle}>ENCRYPTED STORAGE • LEVEL 5</Text>
                </View>
            </View>

            <View style={styles.listContainer}>
                {/* REMOTE UNLOCK */}
                <TouchableOpacity style={styles.listItem} onPress={() => toggleItem('remote')}>
                    <View style={styles.itemLeft}>
                        <View style={[styles.iconBox, { backgroundColor: 'rgba(59,130,246,0.2)' }]}>
                            <Ionicons name="wifi" size={20} color="#3b82f6" />
                        </View>
                        <Text style={styles.itemText}>Remote Unlock</Text>
                    </View>
                    <Ionicons name={expandedId === 'remote' ? "chevron-up" : "chevron-down"} size={20} color="#64748b" />
                </TouchableOpacity>

                {expandedId === 'remote' && (
                    <View style={styles.expandedContent}>
                        <Text style={styles.descriptionText}>
                            Force unlock and resync identity with paired PC using secure uplink.
                        </Text>
                        <TouchableOpacity style={styles.actionButton} onPress={handleRemoteUnlock}>
                            <Text style={styles.actionButtonText}>INITIATE UPLINK</Text>
                        </TouchableOpacity>
                    </View>
                )}

                <View style={styles.separator} />

                {/* MASTER PUK */}
                <TouchableOpacity style={styles.listItem} onPress={() => toggleItem('puk')}>
                    <View style={styles.itemLeft}>
                        <View style={[styles.iconBox, { backgroundColor: 'rgba(239,68,68,0.2)' }]}>
                            <Ionicons name="key" size={20} color="#ef4444" />
                        </View>
                        <Text style={styles.itemText}>Device Recovery Key</Text>
                    </View>
                    <Ionicons name={expandedId === 'puk' ? "chevron-up" : "chevron-down"} size={20} color="#64748b" />
                </TouchableOpacity>

                {expandedId === 'puk' && (
                    <View style={styles.expandedContent}>
                        <Text style={styles.descriptionText}>
                            Cryptographic device identity used for emergency unlock.
                        </Text>

                        <View style={styles.pukBox}>
                            <Text
                                style={styles.pukText}
                                numberOfLines={1}
                                adjustsFontSizeToFit
                                minimumFontScale={0.5}
                            >
                                {isRevealed ? pukCode : (pukCode === "SETUP REQUIRED" ? "SETUP REQUIRED" : "•••• - •••• - ••")}
                            </Text>

                            <TouchableOpacity onPress={handleRevealCode} style={{ paddingLeft: 10 }}>
                                <Ionicons name={isRevealed ? "eye-off" : "eye"} size={24} color="#94a3b8" />
                            </TouchableOpacity>
                        </View>
                    </View>
                )}
            </View>
        </ScrollView>
    );
}



const styles = StyleSheet.create({
    center: { flex: 1, backgroundColor: '#0f172a', justifyContent: 'center', alignItems: 'center' },
    container: { flex: 1, backgroundColor: '#0f172a', paddingTop: 60 },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginBottom: 30 },
    headerIconBg: { width: 50, height: 50, borderRadius: 12, backgroundColor: 'rgba(16,185,129,0.1)', justifyContent: 'center', alignItems: 'center', marginRight: 15, borderWidth: 1, borderColor: 'rgba(16,185,129,0.2)' },
    headerTitle: { color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: 1 },
    headerSubtitle: { color: '#10b981', fontSize: 10, fontWeight: 'bold', letterSpacing: 2, marginTop: 2 },

    listContainer: { backgroundColor: '#1e293b', borderRadius: 16, marginHorizontal: 16, borderWidth: 1, borderColor: '#334155', overflow: 'hidden' },
    listItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 18 },
    itemLeft: { flexDirection: 'row', alignItems: 'center' },
    iconBox: { width: 36, height: 36, borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
    itemText: { color: '#f1f5f9', fontSize: 16, fontWeight: '600' },

    separator: { height: 1, backgroundColor: '#334155', marginLeft: 68 },

    expandedContent: { backgroundColor: '#0f172a', padding: 16, paddingLeft: 68, borderTopWidth: 1, borderTopColor: '#334155' },
    descriptionText: { color: '#94a3b8', fontSize: 13, marginBottom: 15, lineHeight: 20 },

    actionButton: { backgroundColor: '#2563eb', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
    actionButtonText: { color: 'white', fontWeight: 'bold', fontSize: 12, letterSpacing: 1 },

    pukBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1e293b', padding: 14, borderRadius: 8, borderWidth: 1, borderColor: '#334155' },
    pukText: { color: '#fff', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', fontSize: 16, letterSpacing: 1, fontWeight: 'bold', flex: 1, marginRight: 10 }
});
