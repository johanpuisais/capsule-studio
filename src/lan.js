// Accès depuis le réseau local (option LAN=true) : adresses du PC, filtre des clients,
// certificat HTTPS auto-signé créé par Windows (aucune dépendance).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Adresses IPv4 privées de ce PC (cartes réseau actives, hors loopback)
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && isPrivateAddress(a.address)) out.push(a.address);
  }
  return [...new Set(out)];
}

// Clients acceptés : boucle locale et plages privées (10/8, 172.16/12, 192.168/16, 169.254/16)
export function isPrivateAddress(ip) {
  const v4 = String(ip || '').replace(/^::ffff:/, '');
  if (v4 === '::1') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v4);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// Certificat du réseau local : recréé si absent ou si les adresses du PC ont changé.
// Fichiers dans le dossier de données : lan-cert.pfx (privé), lan-cert.json (mot de passe, adresses),
// capsule-studio-reseau.cer (public, à installer sur les autres postes pour éviter l'avertissement).
export function ensureLanCert(dataDir, ips) {
  const pfx = path.join(dataDir, 'lan-cert.pfx');
  const meta = path.join(dataDir, 'lan-cert.json');
  const cer = path.join(dataDir, 'capsule-studio-reseau.cer');
  const host = os.hostname().toLowerCase();
  const names = [...ips].sort().join(',') + `|${host}`;
  if (fs.existsSync(pfx) && fs.existsSync(meta) && fs.existsSync(cer)) {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (m.names === names) return { pfx: fs.readFileSync(pfx), passphrase: m.passphrase, cerFile: cer, created: false };
  }
  const passphrase = crypto.randomBytes(18).toString('base64url');
  const san = ['DNS=localhost', `DNS=${host}`, 'IPAddress=127.0.0.1', ...ips.map((ip) => `IPAddress=${ip}`)].join('&');
  // Certificat créé dans le magasin de l'utilisateur, exporté, puis retiré du magasin
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$c = New-SelfSignedCertificate -Subject "CN=Capsule Studio (reseau local)" -FriendlyName "Capsule Studio (reseau local)" -TextExtension @("2.5.29.17={text}${san}") -CertStoreLocation Cert:\\CurrentUser\\My -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddYears(5)`,
    `$p = ConvertTo-SecureString -String "${passphrase}" -Force -AsPlainText`,
    `Export-PfxCertificate -Cert $c -FilePath "${pfx}" -Password $p -CryptoAlgorithmOption AES256_SHA256 | Out-Null`,
    `Export-Certificate -Cert $c -FilePath "${cer}" | Out-Null`,
    'Remove-Item ("Cert:\\CurrentUser\\My\\" + $c.Thumbprint)'
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe', timeout: 60000 });
  fs.writeFileSync(meta, JSON.stringify({ names, passphrase, createdAt: new Date().toISOString() }, null, 2));
  return { pfx: fs.readFileSync(pfx), passphrase, cerFile: cer, created: true };
}
