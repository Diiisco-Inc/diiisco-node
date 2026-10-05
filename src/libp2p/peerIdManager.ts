import { chmod, readFile, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'node:path'
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { PrivateKey } from '@libp2p/interface'
import type { PeerId } from '@libp2p/interface'
import environment from '../environment/runtime'
import { resolvePath } from '../utils/paths'
import { logger } from '../utils/logger'

/** The peer identity is a private key: readable by its owner only. */
const KEY_FILE_MODE = 0o600

/**
 * Tighten a key file written by an earlier version, which used the process
 * umask (typically 0644, world-readable). POSIX only: Windows has no mode bits
 * to set, and a failure here must never stop the node.
 */
async function restrictKeyFile(filePath: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const { mode } = await stat(filePath)
    if ((mode & 0o077) === 0) return
    await chmod(filePath, KEY_FILE_MODE)
    logger.info(`🔒 Restricted ${filePath} to owner-only (it was readable by other users).`)
  } catch (err: any) {
    logger.warn(`⚠️  Could not restrict permissions on ${filePath}: ${err.message}`)
  }
}

/**
 * Utility class for managing persistent libp2p peer IDs
 * 
 * This class handles the persistence of private keys to ensure
 * consistent peer IDs across application restarts.
 */
export class PeerIdManager {
  /**
   * Loads peer ID from file or creates a new one
   * 
   * @param filePath - Path to the private key file
   * @returns The peer ID and private key
   */
  static async loadOrCreate(fileName: string): Promise<{ peerId: PeerId; privateKey: PrivateKey }> {
    let privateKey: PrivateKey
    let peerId: PeerId
    // `resolvePath` expands `~` via `os.homedir()`. It used to be expanded with
    // `process.env.HOME`, which is unset on Windows — so `~/.diiisco` became
    // `/.diiisco` and the identity landed at the root of the system drive.
    const configuredPath = environment.peerIdStorage.path;
    const sanitizedPath = resolvePath(configuredPath);

    // Check the existence of the protobuf folder
    if (!existsSync(sanitizedPath)) {
      const from = configuredPath === sanitizedPath ? '' : ` (from "${configuredPath}")`;
      throw new Error(`Directory does not exist: ${sanitizedPath}${from}`)
    }

    // Now Make the File Path
    const filePath = join(sanitizedPath, fileName);
    
    if (existsSync(filePath)) {
      logger.info(`📁 Loading existing private key from ${filePath}`)
      try {
        // Read the protobuf private key bytes from file
        const keyBytes = await readFile(filePath)

        // Reconstruct the private key from the protobuf bytes
        privateKey = await privateKeyFromProtobuf(keyBytes)

        // Create peer ID from the private key
        peerId = peerIdFromPrivateKey(privateKey)

        logger.info(`📋 Loaded peer ID: ${peerId.toString()}`)
      } catch (err: any) {
        // Never fall back to a new key here. This file is the node's long-term
        // identity — NFD verification, relay reservations and every peer that
        // knows it are bound to the id — and a read that fails (a truncated
        // file, a transient permission error) is not a reason to replace it.
        throw new Error(
          `Could not read the peer identity at ${filePath}: ${err?.message ?? err}. ` +
          `The file has been left untouched. Restore it from a backup, fix its permissions, ` +
          `or delete it yourself if you really want a new identity (a new peer id loses any NFD bound to the old one).`
        )
      }

      await restrictKeyFile(filePath)
    } else {
      logger.info(`🆕 Creating new private key and saving to ${filePath}`)

      // Generate new private key
      privateKey = await generateKeyPair('Ed25519')
      peerId = peerIdFromPrivateKey(privateKey)

      logger.info(`🆕 Generated new peer ID: ${peerId.toString()}`)

      // Written only when the identity is new — never re-written on a normal
      // start — and owner-only: it is a private key.
      try {
        await writeFile(filePath, privateKeyToProtobuf(privateKey), { mode: KEY_FILE_MODE })
        logger.info(`💾 Private key saved to ${filePath}`)
      } catch (err: any) {
        logger.warn(`⚠️  Failed to save private key: ${err.message}`)
      }
    }

    return { peerId, privateKey }
  }

  /**
   * Alternative method that returns just the private key for use with createLibp2p
   * 
   * @param filePath - Path to the private key file
   * @returns The private key
   */
  static async getPrivateKey(filePath: string): Promise<PrivateKey> {
    const { privateKey } = await this.loadOrCreate(filePath)
    return privateKey
  }
}