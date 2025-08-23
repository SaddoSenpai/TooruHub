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
                // Per your request:
                // 1. Title is the command_tag (prefix)
                // 2. Description is the block_name (title)
                const title = cmd.command_tag.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const description = cmd.block_name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const fullTag = `<${cmd.command_tag}>`;

                return `
                <div class="command-card">
                  <h3 class="command-title">${title}</h3>
                  <p class="command-desc">${description}</p>
                  <div class="command-tag-box">
                    <button class="copy-btn" data-command="${fullTag}">📋</button>
                  </div>
                </div>`;
            }).join('');
            grid.innerHTML = html;

            // Add event listeners to all copy buttons
            document.querySelectorAll('.copy-btn').forEach(button => {
                button.onclick = (e) => {
                    // Use currentTarget to ensure we get the button element
                    const targetButton = e.currentTarget;
                    const commandToCopy = targetButton.dataset.command;
                    
                    navigator.clipboard.writeText(commandToCopy).then(() => {
                        const originalText = targetButton.textContent;
                        targetButton.textContent = 'Copied!';
                        targetButton.classList.add('copied');
                        setTimeout(() => {
                            targetButton.textContent = originalText;
                            targetButton.classList.remove('copied');
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