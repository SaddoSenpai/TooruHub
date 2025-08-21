// public/app.js
const $ = id => document.getElementById(id);
let proxyToken = localStorage.getItem('proxy_token') || null;
let statsInterval = null;
let userSettings = {}; // <-- NEW: To store user settings

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (proxyToken) headers['Authorization'] = 'Bearer ' + proxyToken;
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json', ...headers }, body: opts.body ? JSON.stringify(opts.body) : undefined, method: opts.method || 'GET' });
  const isJson = r.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await r.json() : await r.text();
  if (!r.ok) throw data;
  return data;
}

async function updateStats() {
    try {
        const stats = await api('/api/stats');
        $('statsCpu').textContent = stats.cpu;
        $('statsRam').textContent = stats.ram.used;
        $('statsRpm').textContent = stats.rpm;
    } catch (err) {
        console.error("Failed to fetch stats:", err);
        if (statsInterval) clearInterval(statsInterval);
    }
}

// --- NEW: Function to update UI based on settings ---
function updateUIWithSettings() {
    const usePredefined = userSettings.use_predefined_structure;
    $('promptModeToggle').checked = usePredefined;
    $('btnManagePrompts').disabled = usePredefined;
    if (usePredefined) {
        $('btnManagePrompts').style.cursor = 'not-allowed';
        $('btnManagePrompts').title = 'Disable "Use Pre-defined Structure" to manage your custom prompts.';
        $('promptModeDesc').innerHTML = `Pre-defined mode is <strong>ON</strong>. You can use special &lt;COMMANDS&gt; in your prompts. <a href="/config">/config</a> page is disabled.`;
    } else {
        $('btnManagePrompts').style.cursor = 'pointer';
        $('btnManagePrompts').title = '';
        $('promptModeDesc').innerHTML = `Pre-defined mode is <strong>OFF</strong>. Your custom prompt structure from the <a href="/config">/config</a> page will be used.`;
    }
}

async function loadUserSettings() {
    try {
        const meta = await api('/api/configs/meta');
        userSettings = meta;
        updateUIWithSettings();
    } catch (err) {
        console.error("Failed to load user settings", err);
        alert("Could not load your settings. Please try logging in again.");
    }
}

function showDashboard() {
  $('auth').style.display = 'none';
  $('dashboard').style.display = 'block';
  $('proxyToken').textContent = proxyToken;
  $('exampleCurl').textContent = `# To use a provider-specific endpoint (recommended for llm7.io):
curl "http://localhost:3000/llm7/v1/chat/completions" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${proxyToken}" \\
  -d '{ "model":"open-mistral-7b", "messages":[{"role":"user","content":"Explain to me how AI works"}] }'

# To use the generic endpoint (auto-detects provider from model name):
curl "http://localhost:3000/v1/chat/completions" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${proxyToken}" \\
  -d '{ "model":"gemini-pro", "messages":[{"role":"user","content":"Explain to me how AI works"}] }'`;
  
  loadKeys();
  loadUserSettings(); // <-- NEW

  if (statsInterval) clearInterval(statsInterval);
  updateStats();
  statsInterval = setInterval(updateStats, 3000);
}

async function loadKeys() {
  // ... (this function is unchanged)
  try {
    const providerDisplayNames = {
        gemini: 'gemini',
        openrouter: 'openrouter',
        openai: 'openai',
        llm7: 'llm7.io',
        deepseek: 'deepseek'
    };
    const data = await api('/keys');
    const list = data.keys.map(k => `
      <div class="key-item ${!k.is_active ? 'deactivated' : ''}">
        <div class="key-info">
          <strong>${providerDisplayNames[k.provider] || k.provider}</strong> (${k.name || '-'})
          <div class="muted">Added: ${new Date(k.created_at).toLocaleString()}</div>
          ${!k.is_active ? '<span> ⚠️ Rate-Limited / Inactive</span>' : ''}
        </div>
        <div class="key-actions">
          <button data-id="${k.id}" class="test-btn">Test</button>
          ${k.is_active 
            ? `<button data-id="${k.id}" class="deactivate-btn">Deactivate</button>`
            : `<button data-id="${k.id}" data-reason="${k.deactivation_reason || 'No reason specified.'}" class="reactivate-btn">Reactivate</button>`
          }
          <button data-id="${k.id}" class="del-btn">Delete</button>
        </div>
      </div>`).join('');
    $('keysList').innerHTML = list || '<i>No keys yet</i>';
    
    document.querySelectorAll('.del-btn').forEach(b => b.onclick = async (ev) => {
      const id = ev.target.dataset.id;
      if (!confirm('Delete key?')) return;
      await api('/keys/' + id, { method: 'DELETE' });
      loadKeys();
    });

    document.querySelectorAll('.reactivate-btn').forEach(b => b.onclick = async (ev) => {
        const id = ev.target.dataset.id;
        const reason = ev.target.dataset.reason;
        if (confirm(`This key was deactivated due to the following error:\n\n${reason}\n\nDo you want to reactivate it now?`)) {
            try {
                await api(`/api/keys/${id}/reactivate`, { method: 'POST' });
                loadKeys();
            } catch (err) {
                alert('Failed to reactivate key: ' + JSON.stringify(err));
            }
        }
    });

    document.querySelectorAll('.deactivate-btn').forEach(b => b.onclick = async (ev) => {
        const id = ev.target.dataset.id;
        const reason = prompt("Optional: Enter a reason for deactivating this key.", "Manually deactivated.");
        if (reason === null) return;
        try {
            await api(`/api/keys/${id}/deactivate`, { method: 'POST', body: { reason } });
            loadKeys();
        } catch (err) {
            alert('Failed to deactivate key: ' + JSON.stringify(err));
        }
    });

    document.querySelectorAll('.test-btn').forEach(b => b.onclick = async (ev) => {
        const btn = ev.target;
        const id = btn.dataset.id;
        
        btn.textContent = 'Testing...';
        btn.disabled = true;
        btn.classList.remove('tested-ok');

        try {
            await api(`/api/keys/${id}/test`, { method: 'POST' });
            btn.textContent = 'Key is working';
            btn.classList.add('tested-ok');
        } catch (err) {
            alert('Key test failed:\n\n' + (err.detail ? JSON.stringify(err.detail, null, 2) : JSON.stringify(err)));
            btn.textContent = 'Test';
            btn.disabled = false;
        }
    });

  } catch (err) {
    console.error(err);
    $('keysList').innerHTML = `<pre>${JSON.stringify(err, null, 2)}</pre>`;
  }
}

window.onload = () => {
  if (proxyToken) showDashboard();

  $('btnSignup').onclick = async () => {
    // ... (this function is unchanged)
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
    // ... (this function is unchanged)
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
    // ... (this function is unchanged)
    if (!confirm('Regenerate token? This will invalidate your old token.')) return;
    try {
      const j = await api('/regenerate-token', { method: 'POST' });
      proxyToken = j.proxy_token;
      localStorage.setItem('proxy_token', proxyToken);
      $('proxyToken').textContent = proxyToken;
      showDashboard();
    } catch (err) { alert(JSON.stringify(err)); }
  };

  $('btnAddKey').onclick = async () => {
    // ... (this function is unchanged)
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

  // --- NEW: Event listener for the prompt mode toggle ---
  $('promptModeToggle').onchange = async (ev) => {
    const isChecked = ev.target.checked;
    try {
        await api('/api/configs/settings', {
            method: 'PUT',
            body: { use_predefined_structure: isChecked }
        });
        userSettings.use_predefined_structure = isChecked;
        updateUIWithSettings();
    } catch (err) {
        alert('Failed to save setting: ' + JSON.stringify(err));
        ev.target.checked = !isChecked; // Revert on failure
    }
  };

  $('btnManagePrompts').onclick = () => {
    window.location.href = '/config';
  };

  $('btnLogout').onclick = () => {
    if (statsInterval) clearInterval(statsInterval);
    proxyToken = null;
    localStorage.removeItem('proxy_token');
    location.reload();
  };
};