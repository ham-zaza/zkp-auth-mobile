import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

/*
  MUST MATCH BACKEND + EXTENSION EXACTLY
*/
const ZKP_PARAMS = {
    p: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
    q: 0x7fffffff800000008000000000000000000000007fffffffffffffffffffffffn,
    g: 0x2n,
    h: 0x4n // Quadratic residue
};

/* ------------------ UTILITIES ------------------ */

// Modular exponentiation (BigInt-safe)
function modExp(base, exp, mod) {
    let result = 1n;
    let b = base % mod;
    let e = exp;

    while (e > 0n) {
        if (e & 1n) result = (result * b) % mod;
        b = (b * b) % mod;
        e >>= 1n;
    }
    return result;
}

// Fiat–Shamir hash (MUST MATCH BACKEND ORDER & CONCAT)
async function fiatShamirHash(g, h, y, z, a, b, domain, timestamp) {
    const transcript =
        g +
        h +
        y +
        z +
        a +
        b +
        domain +
        timestamp;

    const hashHex = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        transcript,
        { encoding: Crypto.CryptoEncoding.HEX }
    );

    return BigInt('0x' + hashHex) % ZKP_PARAMS.q;
}

/* ------------------ CRYPTO SERVICE ------------------ */

export const CryptoService = {
    /*
      1. Get or generate private secret X
      Stored securely on device
    */
    async getOrGenerateSecret() {
        const stored = await SecureStore.getItemAsync('zkp_secret_v1');

        if (stored) {
            return BigInt(stored);
        }

        const randomBytes = await Crypto.getRandomBytesAsync(32);
        const hex = Array.from(randomBytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        const x = BigInt('0x' + hex) % ZKP_PARAMS.q;
        await SecureStore.setItemAsync('zkp_secret_v1', x.toString());
        return x;
    },

    /*
      2. Public key derivation (for registration)
    */
    async getPublicKeys(secretX) {
        const y = modExp(ZKP_PARAMS.g, secretX, ZKP_PARAMS.p);
        const z = modExp(ZKP_PARAMS.h, secretX, ZKP_PARAMS.p);

        return {
            y: y.toString(),
            z: z.toString()
        };
    },

    /*
      3. Generate ZKP proof (Mobile Prover)
    */
    async generateProof(secretX, domain = 'chrome-extension://zk-auth') {
        const timestamp = Math.floor(Date.now() / 1000);

        // Random nonce k
        const rand = await Crypto.getRandomBytesAsync(32);
        const kHex = Array.from(rand)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        const k = BigInt('0x' + kHex) % ZKP_PARAMS.q;

        // Commitments
        const a = modExp(ZKP_PARAMS.g, k, ZKP_PARAMS.p);
        const b = modExp(ZKP_PARAMS.h, k, ZKP_PARAMS.p);

        // Public keys
        const y = modExp(ZKP_PARAMS.g, secretX, ZKP_PARAMS.p);
        const z = modExp(ZKP_PARAMS.h, secretX, ZKP_PARAMS.p);

        // Fiat–Shamir challenge
        const c = await fiatShamirHash(
            ZKP_PARAMS.g.toString(),
            ZKP_PARAMS.h.toString(),
            y.toString(),
            z.toString(),
            a.toString(),
            b.toString(),
            domain,
            timestamp.toString()
        );

        // Response
        const s = (k + c * secretX) % ZKP_PARAMS.q;

        // Payload expected by backend
        return {
            a: a.toString(),
            b: b.toString(),
            s: s.toString(),
            timestamp,
            domain
        };
    }
};
