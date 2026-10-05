import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dataDir } from './db.js'

const keyPath = resolve(dataDir, 'secret.key')

function localKey(): Buffer {
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' })
  }
  chmodSync(keyPath, 0o600)
  const key = readFileSync(keyPath)
  if (key.length !== 32) throw new Error('本地密钥文件已损坏')
  return key
}

export function encryptKey(value: string | null | undefined): string | null {
  if (!value) return null
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', localKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

export function decryptKey(value: string | null): string {
  if (!value) return ''
  const payload = Buffer.from(value, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', localKey(), payload.subarray(0, 12))
  decipher.setAuthTag(payload.subarray(12, 28))
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8')
}
