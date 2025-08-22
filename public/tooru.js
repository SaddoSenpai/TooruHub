// public/tooru.js
const $ = id => document.getElementById(id);
const proxyToken = localStorage.getItem('proxy_token');

if (!proxyToken) {
    alert('You must be logged in. Redirecting to home.');
    location.href = '/';
}

async function api(path, opts = {}) {
    const headers = { 'Authorization': 'Bearer ' + proxyToken, ...(opts.headers || {}) };
    if (!opts.isFormData) {
        headers['Content-Type'] = 'application/json';
    }
    const r = await fetch('/api/tooru' + path, {
        headers,
        body: opts.isFormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined),
        method: opts.method || 'GET'
    });
    if (r.status === 204) return;
    const contentType = r.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        const data = await r.json();
        if (!r.ok) throw data;
        return data;
    }
    if (!r.ok) throw await r.text();
    return r;
}

// --- GLOBAL STATE ---
let activeTab = 'structure';
let activeProvider = 'default'; // NEW: State for the selected provider
let savedBlocks = [];
let draftBlocks = [];
let commands = [];

// --- UTILS ---
function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.dataset.tab === tabName));
}

// --- STRUCTURE MANAGEMENT ---
const REQUIRED_PLACEHOLDERS = ['<<CHARACTER_INFO>>', '<<SCENARIO_INFO>>', '<<SUMMARY>>', '<<USER_INFO>>', '<<CHAT_HISTORY>>'];

function validateStructure(blocks) {
    const standardBlocks = blocks.filter(b => b.is_enabled && (b.block_type === 'Standard' || b.block_type === 'Conditional Prefill'));
    const fullContent = standardBlocks.map(b => b.content || '').join('');
    return REQUIRED_PLACEHOLDERS.filter(p => !fullContent.includes(p));
}

function checkForUnsavedChanges() {
    const hasChanges = JSON.stringify(savedBlocks) !== JSON.stringify(draftBlocks);
    $('saveStructureBtn').disabled = !hasChanges;
    $('discardStructureBtn').disabled = !hasChanges;
}

function renderBlocks() {
    const container = $('blocksList');
    let html = '';
    const missing = validateStructure(draftBlocks);
    if (missing.length > 0) {
        html += `<div class="validation-error"><strong>Invalid Configuration!</strong> Standard/Conditional blocks are missing: ${missing.join(', ')}</div>`;
    }
    if (draftBlocks.length === 0) {
        html += `<i>No blocks defined for the '${activeProvider}' provider. It will use the 'Default' structure if one exists.</i>`;
    } else {
        html += draftBlocks.map((b, index) => {
            const isInjectionPoint = b.block_type === 'Jailbreak' || b.block_type === 'Additional Commands' || b.block_type === 'Prefill';
            const isConditional = b.block_type === 'Conditional Prefill';
            let blockClass = '';
            let blockTypeText = '';
            if (isInjectionPoint) {
                blockClass = 'is-injection-point';
                blockTypeText = `[${b.block_type} Injection Point]`;
            } else if (isConditional) {
                blockClass = 'is-conditional';
                blockTypeText = `[Conditional Prefill]`;
            }

            return `
        <div class="block-item ${!b.is_enabled ? 'is-disabled' : ''} ${blockClass}" data-index="${index}">
          <div class="block-header">
            <label class="switch-toggle"><input type="checkbox" class="enable-toggle" ${b.is_enabled ? 'checked' : ''}><span class="slider round"></span></label>
            <div class="block-title"><strong>${b.name}</strong> <small>(${b.role})</small> <span class="muted">${blockTypeText}</span></div>
            <div class="block-actions">
              <div class="reorder-btns"><button class="up-btn">↑</button><button class="down-btn">↓</button></div>
              <button class="edit-btn">Edit</button><button class="del-btn">Delete</button>
            </div>
          </div>
          <div class="edit-form">
            <div class="form-row">
                <input class="edit-name" value="${b.name}"/>
                <select class="edit-role">
                    <option value="system" ${b.role === 'system' ? 'selected' : ''}>system</option>
                    <option value="user" ${b.role === 'user' ? 'selected' : ''}>user</option>
                    <option value="assistant" ${b.role === 'assistant' ? 'selected' : ''}>assistant</option>
                </select>
            </div>
            <div class="form-row">
                <label>Block Type:</label>
                <select class="edit-block-type">
                    <option value="Standard" ${b.block_type === 'Standard' ? 'selected' : ''}>Standard</option>
                    <option value="Jailbreak" ${b.block_type === 'Jailbreak' ? 'selected' : ''}>Jailbreak Injection Point</option>
                    <option value="Additional Commands" ${b.block_type === 'Additional Commands' ? 'selected' : ''}>Additional Commands Injection Point</option>
                    <option value="Prefill" ${b.block_type === 'Prefill' ? 'selected' : ''}>Prefill Injection Point</option>
                    <option value="Conditional Prefill" ${b.block_type === 'Conditional Prefill' ? 'selected' : ''}>Conditional Prefill (Fallback)</option>
                </select>
            </div>
            <textarea class="edit-content" ${isInjectionPoint ? 'disabled' : ''}>${b.content || ''}</textarea>
            <div class="edit-form-actions"><button class="cancel-btn discard-btn">Cancel</button><button class="save-edit-btn save-btn">Save</button></div>
          </div>
        </div>`}).join('');
    }
    container.innerHTML = html;
    attachBlockEventListeners();
    checkForUnsavedChanges();
}

function attachBlockEventListeners() {
    $('blocksList').querySelectorAll('.block-item').forEach(el => {
        const index = parseInt(el.dataset.index, 10);
        el.querySelector('.enable-toggle').onchange = (e) => {
            draftBlocks[index].is_enabled = e.target.checked;
            renderBlocks();
        };
        el.querySelector('.up-btn').onclick = () => {
            if (index > 0) {
                [draftBlocks[index], draftBlocks[index - 1]] = [draftBlocks[index - 1], draftBlocks[index]];
                renderBlocks();
            }
        };
        el.querySelector('.down-btn').onclick = () => {
            if (index < draftBlocks.length - 1) {
                [draftBlocks[index], draftBlocks[index + 1]] = [draftBlocks[index + 1], draftBlocks[index]];
                renderBlocks();
            }
        };
        el.querySelector('.del-btn').onclick = () => {
            draftBlocks.splice(index, 1);
            renderBlocks();
        };
        el.querySelector('.edit-btn').onclick = () => el.classList.add('is-editing');
        el.querySelector('.cancel-btn').onclick = () => {
            el.classList.remove('is-editing');
            renderBlocks(); // Re-render to discard edit form changes
        };
        el.querySelector('.save-edit-btn').onclick = () => {
            draftBlocks[index].name = el.querySelector('.edit-name').value;
            draftBlocks[index].role = el.querySelector('.edit-role').value;
            draftBlocks[index].block_type = el.querySelector('.edit-block-type').value;
            draftBlocks[index].content = el.querySelector('.edit-content').value;
            el.classList.remove('is-editing');
            renderBlocks();
        };
        const editBlockTypeSelect = el.querySelector('.edit-block-type');
        if (editBlockTypeSelect) {
            editBlockTypeSelect.onchange = (e) => {
                const isInjection = e.target.value === 'Jailbreak' || e.target.value === 'Additional Commands' || e.target.value === 'Prefill';
                el.querySelector('.edit-content').disabled = isInjection;
            };
        }
    });
}

async function loadGlobalBlocks() {
    try {
        // MODIFIED: Pass the activeProvider to the API call
        const { blocks } = await api(`/global-blocks?provider=${activeProvider}`);
        savedBlocks = JSON.parse(JSON.stringify(blocks));
        draftBlocks = JSON.parse(JSON.stringify(blocks));
        renderBlocks();
    } catch (err) {
        $('blocksList').innerHTML = `<div class="validation-error">Error loading global blocks. You may not be an admin.</div>`;
        console.error(err);
    }
}

// --- COMMAND MANAGEMENT (Unchanged) ---
function renderCommands() {
    const container = $('commandsList');
    if (commands.length === 0) {
        container.innerHTML = '<i>No commands defined.</i>';
        return;
    }
    container.innerHTML = commands.map(c => `
        <div class="command-item" data-id="${c.id}">
            <div>
                <strong>&lt;${c.command_tag}&gt;</strong> - ${c.block_name} <small>(${c.block_role}, type: ${c.command_type})</small>
            </div>
            <div>
                <button class="cmd-edit-btn">Edit</button>
                <button class="cmd-del-btn">Delete</button>
            </div>
        </div>
    `).join('');
    attachCommandEventListeners();
}
function attachCommandEventListeners() {
    $('commandsList').querySelectorAll('.command-item').forEach(el => {
        const id = el.dataset.id;
        el.querySelector('.cmd-edit-btn').onclick = () => {
            const cmd = commands.find(c => c.id == id);
            $('cmd_id').value = cmd.id;
            $('cmd_tag').value = cmd.command_tag;
            $('cmd_name').value = cmd.block_name;
            $('cmd_role').value = cmd.block_role;
            $('cmd_content').value = cmd.block_content;
            $('cmd_type').value = cmd.command_type;
            window.scrollTo(0, document.body.scrollHeight);
        };
        el.querySelector('.cmd-del-btn').onclick = async () => {
            if (!confirm(`Delete command <${el.querySelector('strong').textContent.slice(1, -1)}>?`)) return;
            try {
                await api(`/commands/${id}`, { method: 'DELETE' });
                loadCommands();
            } catch (err) {
                alert('Failed to delete command: ' + JSON.stringify(err));
            }
        };
    });
}
function clearCommandForm() {
    $('cmd_id').value = '';
    $('cmd_tag').value = '';
    $('cmd_name').value = '';
    $('cmd_content').value = '';
}
async function loadCommands() {
    try {
        const data = await api('/commands');
        commands = data.commands;
        renderCommands();
    } catch (err) {
        $('commandsList').innerHTML = `<div class="validation-error">Error loading commands.</div>`;
        console.error(err);
    }
}

// --- INITIALIZATION ---
window.onload = () => {
    // Tab switching
    $('adminTabs').querySelectorAll('.tab-btn').forEach(btn => {
        btn.onclick = () => switchTab(btn.dataset.tab);
    });

    // NEW: Listener for the provider selector dropdown
    $('providerSelector').onchange = (e) => {
        const hasChanges = JSON.stringify(savedBlocks) !== JSON.stringify(draftBlocks);
        if (hasChanges && !confirm('You have unsaved changes for the current provider. Are you sure you want to switch and lose them?')) {
            e.target.value = activeProvider; // Revert the dropdown change
            return;
        }
        activeProvider = e.target.value;
        $('blocksList').innerHTML = 'Loading...';
        loadGlobalBlocks();
    };

    // Structure tab listeners
    $('saveStructureBtn').onclick = async () => {
        const missing = validateStructure(draftBlocks);
        if (missing.length > 0) {
            return alert(`Cannot save. Structure is invalid. Missing from Standard/Conditional blocks: ${missing.join(', ')}`);
        }
        try {
            // MODIFIED: Pass the activeProvider to the API call
            const { blocks } = await api(`/global-blocks?provider=${activeProvider}`, { method: 'PUT', body: { blocks: draftBlocks } });
            savedBlocks = JSON.parse(JSON.stringify(blocks));
            draftBlocks = JSON.parse(JSON.stringify(blocks));
            renderBlocks();
            alert(`Global structure for '${activeProvider}' saved!`);
        } catch (err) {
            alert('Failed to save: ' + JSON.stringify(err));
        }
    };
    $('discardStructureBtn').onclick = () => {
        draftBlocks = JSON.parse(JSON.stringify(savedBlocks));
        renderBlocks();
    };
    $('new_block_type').onchange = (e) => {
        const isInjection = e.target.value === 'Jailbreak' || e.target.value === 'Additional Commands' || e.target.value === 'Prefill';
        $('new_content').disabled = isInjection;
    };
    $('btnAddBlock').onclick = () => {
        draftBlocks.push({
            name: $('new_name').value || 'New Block',
            role: $('new_role').value,
            content: $('new_content').value,
            is_enabled: true,
            block_type: $('new_block_type').value
        });
        $('new_name').value = '';
        $('new_content').value = '';
        renderBlocks();
    };
    $('exportStructureBtn').onclick = async () => {
        const response = await fetch(`/api/tooru/global-blocks/export?provider=${activeProvider}`, { headers: { 'Authorization': 'Bearer ' + proxyToken } });
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tooruhub_global_${activeProvider}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
    };
    $('importStructureInput').onchange = async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        if (!confirm(`This will OVERWRITE the entire global structure for '${activeProvider}'. Are you sure?`)) {
            ev.target.value = '';
            return;
        }
        try {
            const formData = new FormData();
            formData.append('configFile', file);
            await api(`/global-blocks/import?provider=${activeProvider}`, { method: 'POST', body: formData, isFormData: true });
            await loadGlobalBlocks();
            alert(`Global structure for '${activeProvider}' imported successfully!`);
        } catch (err) {
            alert('Import failed: ' + (err.detail || JSON.stringify(err)));
        } finally {
            ev.target.value = '';
        }
    };

    // Command tab listeners
    $('cmd_clear_btn').onclick = clearCommandForm;
    $('cmd_save_btn').onclick = async () => {
        const id = $('cmd_id').value;
        const body = {
            command_tag: $('cmd_tag').value,
            block_name: $('cmd_name').value,
            block_role: $('cmd_role').value,
            block_content: $('cmd_content').value,
            command_type: $('cmd_type').value,
        };
        try {
            if (id) {
                await api(`/commands/${id}`, { method: 'PUT', body });
            } else {
                await api('/commands', { method: 'POST', body });
            }
            clearCommandForm();
            loadCommands();
        } catch (err) {
            alert('Failed to save command: ' + JSON.stringify(err));
        }
    };

    // Initial data load
    loadGlobalBlocks();
    loadCommands();
};