// Connexion ou création du mot de passe propriétaire (premier lancement)
// Même thème que le studio (choix mémorisé, sinon préférence système)
try { const t = localStorage.getItem('cs.theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* stockage indisponible */ }
const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');
const pwd = document.getElementById('password');
const pwd2 = document.getElementById('password2');
let setupMode = false;

const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Capsule-CSRF': '1' },
  body: JSON.stringify(body)
});

const state = await (await fetch('/api/v1/session')).json();
if (state.authenticated) location.href = '/';
if (!state.ownerExists) {
  setupMode = true;
  document.getElementById('login-intro').textContent = 'Premier lancement : choisissez le mot de passe du propriétaire (10 caractères minimum). Il est stocké haché sur cette machine.';
  document.getElementById('confirm-wrap').hidden = false;
  document.getElementById('login-submit').textContent = 'Créer le mot de passe';
  pwd.autocomplete = 'new-password';
}
pwd.focus();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  // Validation côté client (le serveur reste l'autorité)
  if (pwd.value.length < 10) { errorEl.textContent = 'Le mot de passe doit faire au moins 10 caractères.'; return; }
  if (setupMode && pwd.value !== pwd2.value) { errorEl.textContent = 'Les deux mots de passe ne correspondent pas.'; return; }
  const res = await post(setupMode ? '/api/v1/session/setup' : '/api/v1/session/login', { password: pwd.value });
  if (res.ok) { location.href = '/'; return; }
  const data = await res.json().catch(() => ({}));
  errorEl.textContent = data.error?.message || 'Connexion impossible.';
});
