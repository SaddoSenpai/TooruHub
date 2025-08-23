// public/commands.js
window.onload = async () => {
    const grid = document.getElementById('commands-grid');
    try {
        const response = await fetch('/api/commands/public');
        if (!response.ok) {
            throw new Error('Failed to fetch commands from the server.');
        }
        const data = await response.json();

        if (data.commands && data.commands.length > 0) {
            const html = data.commands.map(cmd => {
                // Escape potential HTML characters in user-defined names
                const name = cmd.block_name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const tag = cmd.command_tag.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const fullTag = `<${tag}>`;

                return `
                <div class="command-card">
                  <h3 class="command-title">${name}</h3>
                  <p class="command-desc">Activates the "${name}" functionality.</p>
                  <div class="command-tag-box">
                    <code>${fullTag}</code>
                    <button class="copy-btn" data-command="${fullTag}">📋</button>
                  </div>
                </div>`;
            }).join('');
            grid.innerHTML = html;

            // Add event listeners to all copy buttons
            document.querySelectorAll('.copy-btn').forEach(button => {
                button.onclick = (e) => {
                    const commandToCopy = e.target.dataset.command;
                    navigator.clipboard.writeText(commandToCopy).then(() => {
                        const originalText = button.textContent;
                        button.textContent = 'Copied!';
                        button.classList.add('copied');
                        setTimeout(() => {
                            button.textContent = originalText;
                            button.classList.remove('copied');
                        }, 1500);
                    }).catch(err => {
                        console.error('Failed to copy command: ', err);
                        alert('Failed to copy command.');
                    });
                };
            });

        } else {
            grid.innerHTML = '<p>No commands have been defined by the administrator yet.</p>';
        }
    } catch (error) {
        console.error(error);
        grid.innerHTML = `<p style="color: #ff5555;">Error: Could not load the command list. Please try again later.</p>`;
    }
};