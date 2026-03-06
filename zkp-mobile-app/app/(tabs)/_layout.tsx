import { Tabs } from 'expo-router';
import React from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons'; // ✅ SAFE ICONS
import { HapticTab } from '@/components/haptic-tab';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export default function TabLayout() {
    const colorScheme = useColorScheme();
    // Force Dark Mode vibe for consistent look or match system
    const activeColor = Colors[colorScheme ?? 'light'].tint;

    return (
        <Tabs
            screenOptions={{
                tabBarActiveTintColor: activeColor,
                headerShown: false,
                tabBarButton: HapticTab,
                tabBarStyle: Platform.select({
                    ios: { position: 'absolute', backgroundColor: 'rgba(20,20,20,0.9)', borderTopColor: '#333' },
                    default: { backgroundColor: '#111', borderTopColor: '#333' },
                }),
            }}>

            {/* Tab 1: Scan (Home) */}
            <Tabs.Screen
                name="index"
                options={{
                    title: 'Scan',
                    tabBarIcon: ({ color, focused }) => (
                        // ✅ Using Ionicons specifically to ensure they SHOW UP
                        <Ionicons size={24} name={focused ? "qr-code" : "qr-code-outline"} color={color} />
                    ),
                }}
            />

            {/* Tab 2: Vault */}
            <Tabs.Screen
                name="vault"
                options={{
                    title: 'Vault',
                    tabBarIcon: ({ color, focused }) => (
                        <Ionicons size={24} name={focused ? "shield-checkmark" : "shield-checkmark-outline"} color={color} />
                    ),
                }}
            />

            {/* Explore Removed */}
            <Tabs.Screen name="explore" options={{ href: null }} />
        </Tabs>
    );
}