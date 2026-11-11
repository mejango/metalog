'use client'

import { createCenterWalletClient } from '@me.jango/signa/core'
import { SIGNA_AUDIENCE, SIGNA_ISSUER, walletReturnPath } from './wallet'
const returnKey = 'metalog:signa:return:v1'
let wallet: ReturnType<typeof createCenterWalletClient> | undefined

export function signaWallet() {
  if (process.env.NEXT_PUBLIC_SIGNA_ENABLED !== 'true') throw new Error('Signa is not configured for this site.')
  wallet ??= createCenterWalletClient({ issuer: SIGNA_ISSUER, audience: SIGNA_AUDIENCE, callbackUri: `${window.location.origin}/center/callback` })
  return wallet
}

export function saveWalletReturnPath() {
  const path = walletReturnPath(window.location.pathname)
  window.sessionStorage.setItem(returnKey, path)
  if (window.sessionStorage.getItem(returnKey) !== path) throw new Error('This tab could not preserve the original page.')
}

export function originalWalletPage() {
  return walletReturnPath(window.sessionStorage.getItem(returnKey) ?? '/')
}
