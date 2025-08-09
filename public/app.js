// public/app.js
const $ = id => document.getElementById(id);
let proxyToken = localStorage.getItem('proxy_token') || null;

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (proxyToken) headers['Authorization'] = 'Bearer ' + proxyToken;
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json', ...headers }, body: opts.body ? JSON.stringify(opts.body) : undefined, method: opts.method || 'GET' });
  const isJson = r.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await r.json() : await r.text();
  if (!r.ok) throw data;
  return data;
}

function showDashboard() {
  $('auth').style.display = 'none';
  $('dashboard').style.display = 'block';
  $('proxyToken').textContent = proxyToken;
  $('exampleCurl').textContent = `curl "http://localhost:3000/v1/chat/completions" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${proxyToken}" \\
  -d '{ "model":"gemini-2.0-flash", "messages":[{"role":"user","content":"Explain to me how AI works"}] }'`;
  loadKeys();
}

async function loadKeys() {
  try {
    const data = await api('/keys');
    const list = data.keys.map(k => `<div class="key-item">
      <strong>${k.provider}</strong> (${k.name || '-'}) — ${new Date(k.created_at).toLocaleString()}
      <button data-id="${k.id}" class="del-btn">Delete</button>
    </div>`).join('');
    $('keysList').innerHTML = list || '<i>No keys yet</i>';
    document.querySelectorAll('.del-btn').forEach(b => b.onclick = async (ev) => {
      const id = ev.target.dataset.id;
      if (!confirm('Delete key?')) return;
      await api('/keys/' + id, { method: 'DELETE' });
      loadKeys();
    });
  } catch (err) {
    console.error(err);
    $('keysList').innerHTML = `<pre>${JSON.stringify(err, null, 2)}</pre>`;
  }
}

window.onload = () => {
  if (proxyToken) showDashboard();

  $('btnSignup').onclick = async () => {
    const username = $('su_username').value;
    const password = $('su_password').value;
    try {
      const r = await fetch('/signup', { method: 'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ username, password })});
      const j = await r.json();
      if (!r.ok) throw j;
      proxyToken = j.proxy_token;
      localStorage.setItem('proxy_token', proxyToken);
      showDashboard();
    } catch (err) { alert('Signup failed: ' + JSON.stringify(err)); }
  };

  $('btnLogin').onclick = async () => {
    const username = $('li_username').value;
    const password = $('li_password').value;
    try {
      const r = await fetch('/login', { method: 'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ username, password })});
      const j = await r.json();
      if (!r.ok) throw j;
      proxyToken = j.proxy_token;
      localStorage.setItem('proxy_token', proxyToken);
      showDashboard();
    } catch (err) { alert('Login failed: ' + JSON.stringify(err)); }
  };

  $('btnRegenerate').onclick = async () => {
    if (!confirm('Regenerate token? This will invalidate your old token.')) return;
    try {
      const j = await api('/regenerate-token', { method: 'POST' });
      proxyToken = j.proxy_token;
      localStorage.setItem('proxy_token', proxyToken);
      $('proxyToken').textContent = proxyToken;
      loadKeys();
    } catch (err) { alert(JSON.stringify(err)); }
  };

  $('btnAddKey').onclick = async () => {
    const provider = $('providerSelect').value;
    const name = $('keyName').value;
    const apiKey = $('apiKey').value;
    try {
      await api('/add-keys', { method: 'POST', body: { provider, name, apiKey } });
      $('keyName').value = '';
      $('apiKey').value = '';
      loadKeys();
    } catch (err) { alert('Failed: ' + JSON.stringify(err)); }
  };

  $('btnManagePrompts').onclick = () => {
    window.location.href = '/config';
  };

  $('btnLogout').onclick = () => {
    proxyToken = null;
    localStorage.removeItem('proxy_token');
    location.reload();
  };
};