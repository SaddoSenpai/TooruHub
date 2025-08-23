// public/commands.js
window.onload = async () => {
    const listBody = document.getElementById('commandsListBody');
    try {
        const response = await fetch('/api/commands/public');
        if (!response.ok) {
            throw new Error('Failed to fetch commands from the server.');
        }
        const data = await response.json();

        if (data.commands && data.commands.length > 0) {
            const html = data.commands.map(cmd => {
                // Escape HTML to be safe, though these fields should be fine.
                const tag = cmd.command_tag.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const name = cmd.block_name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return `<tr><td>&lt;${tag}&gt;</td><td>${name}</td></tr>`;
            }).join('');
            listBody.innerHTML = html;
        } else {
            listBody.innerHTML = '<tr><td colspan="2">No commands have been defined by the administrator yet.</td></tr>';
        }
    } catch (error) {
        console.error(error);
        listBody.innerHTML = `<tr><td colspan="2" style="color: red;">Error: Could not load the command list. Please try again later.</td></tr>`;
    }
};