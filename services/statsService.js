// services/statsService.js
const osUtils = require('os-utils');

let requestCount = 0;
let requestsLastMinute = 0;

// Every minute, update the RPM (Requests Per Minute) and reset the counter.
setInterval(() => {
    requestsLastMinute = requestCount;
    requestCount = 0;
    console.log(`[Stats] RPM last minute: ${requestsLastMinute}`);
}, 60 * 1000);

// Function to be called by the proxy controller on every request.
function incrementRequestCount() {
    requestCount++;
}

// Function to get all current stats.
function getStats() {
    return new Promise((resolve) => {
        // os-utils.cpuUsage is async, so we use a promise.
        osUtils.cpuUsage((cpuPercent) => {
            
            // --- THIS IS THE CORRECTED BLOCK ---
            // Instead of using the 'os' module for memory, which reports the host machine's memory,
            // we use 'process.memoryUsage()' to get the memory usage of this specific Node.js process.
            // 'rss' (Resident Set Size) is the most accurate measure of total memory used.
            const memoryUsage = process.memoryUsage();
            const usedMemInBytes = memoryUsage.rss; 
            // --- END OF CORRECTED BLOCK ---

            resolve({
                cpu: (cpuPercent * 100).toFixed(1), // e.g., 15.2
                ram: {
                    // We now report the process's actual memory usage.
                    used: (usedMemInBytes / 1024 / 1024).toFixed(0) // in MB
                },
                rpm: requestsLastMinute
            });
        });
    });
}

console.log('Statistics service initialized.');

module.exports = {
    incrementRequestCount,
    getStats
};