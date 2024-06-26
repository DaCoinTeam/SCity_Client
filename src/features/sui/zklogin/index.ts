import { Ed25519Keypair } from "@mysten/sui.js/keypairs/ed25519"
import { suiClient } from "../base.sui"
import {
    generateNonce,
    generateRandomness,
    getExtendedEphemeralPublicKey,
    getZkLoginSignature,
    jwtToAddress,
} from "@mysten/zklogin"
import {
    OpenIdProvider,
    getZkLoginSession,
    removeZkLoginSession,
    saveZkLoginSession,
} from "./storage.zklogin"
import { decodeSuiPrivateKey } from "@mysten/sui.js/cryptography"
import axios from "axios"
import { jwtDecode } from "jwt-decode"
import { authProvidersConfig } from "@config"

export interface RandomessAndNonce {
    randomness: string
    nonce: string
}

export enum AuthProviderEnum {
    Google,
    Facebook,
}

export type PartialZkLoginSignature = Omit<
    Parameters<typeof getZkLoginSignature>["0"]["inputs"],
    "addressSeed"
>

export type ZkLoginAccountData = {
    provider: OpenIdProvider
    userAddress: string
    zkProofs: PartialZkLoginSignature
    ephemeralPrivateKey: string
    userSalt?: string
    sub?: string
    aud?: string
    maxEpoch: number
}

export const beginZkLogin = async (
    providerEnum: AuthProviderEnum = AuthProviderEnum.Google
) => {
    const { epoch } = await suiClient.getLatestSuiSystemState()
    const maxEpoch = Number(epoch) + 2

    const ephemeralKeyPair = new Ed25519Keypair()
    const randomness = generateRandomness()

    const nonce = generateNonce(
        ephemeralKeyPair.getPublicKey(),
        maxEpoch,
        randomness
    )

    let url: string
    let openIdProvider: OpenIdProvider

    switch (providerEnum) {
    case AuthProviderEnum.Google: {
        const redirectUrl = window.location.href
        url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${authProvidersConfig.google.clientId}&response_type=id_token&redirect_uri=${redirectUrl}&scope=openid&nonce=${nonce}`
        openIdProvider = "Google"
        break
    }
    default: {
        url = ""
        openIdProvider = "Facebook"
    }
    }

    saveZkLoginSession({
        ephemeralPrivateKey: ephemeralKeyPair.getSecretKey(),
        jwtRandomness: randomness,
        maxEpoch,
        openIdProvider,
    })

    window.location.replace(url)
}

const keypairFromSecretKey = (privateKeyBase64: string): Ed25519Keypair => {
    const keyPair = decodeSuiPrivateKey(privateKeyBase64)
    return Ed25519Keypair.fromSecretKey(keyPair.secretKey)
}

export const completeZkLogin = async (): Promise<ZkLoginAccountData | null> => {
    const urlFragment = window.location.hash.substring(1)
    const urlParams = new URLSearchParams(urlFragment)
    const jwt = urlParams.get("id_token")
    if (!jwt) {
        return null
    }

    window.history.replaceState(null, "", window.location.pathname)

    const jwtPayload = jwtDecode(jwt)
    if (!jwtPayload.sub || !jwtPayload.aud) {
        console.warn("[completeZkLogin] missing jwt.sub or jwt.aud")
        return null
    }

    const requestOptions = {
        method: "GET",
    }

    const saltResponse: { salt: string } | null = await fetch(
        "/test-salt.json",
        requestOptions
    )
        .then((res) => {
            console.debug("[completeZkLogin] salt service success")
            return res.json()
        })
        .catch((error: unknown) => {
            console.warn("[completeZkLogin] salt service error:", error)
            return
        })
    if (!saltResponse) {
        return null
    }

    const userSalt = BigInt(saltResponse.salt)
    const userAddress = jwtToAddress(jwt, userSalt)

    const savedZkLoginSession = getZkLoginSession()
    if (!savedZkLoginSession) {
        console.warn("[completeZkLogin] missing session storage data")
        return null
    }

    removeZkLoginSession()

    const ephemeralKeyPair = keypairFromSecretKey(
        savedZkLoginSession.ephemeralPrivateKey
    )
    const ephemeralPublicKey = ephemeralKeyPair.getPublicKey()
    const payload = JSON.stringify(
        {
            maxEpoch: savedZkLoginSession.maxEpoch,
            jwtRandomness: savedZkLoginSession.jwtRandomness,
            extendedEphemeralPublicKey:
                getExtendedEphemeralPublicKey(ephemeralPublicKey),
            jwt,
            salt: userSalt.toString(),
            keyClaimName: "sub",
        },
        null,
        2
    )

    return await axios
        .post("https://prover-dev.mystenlabs.com/v1", payload, {
            headers: { "Content-Type": "application/json" },
        })
        .then(({ data }) => {
            console.debug("[completeZkLogin] ZK proving service success")
            return {
                userAddress,
                provider: savedZkLoginSession.openIdProvider,
                zkProofs: data,
                ephemeralPrivateKey: savedZkLoginSession.ephemeralPrivateKey,
                maxEpoch: savedZkLoginSession.maxEpoch,
            }
        })
        .catch((error: unknown) => {
            console.warn("[completeZkLogin] ZK proving service error:", error)
            return null
        })
}

export * from "./storage.zklogin"
