"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const socket_io_client_1 = require("socket.io-client");
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const url = args.url;
    const token = args.token;
    const mode = args.mode;
    if (!url || !token || !mode) {
        printUsageAndExit();
    }
    const socket = (0, socket_io_client_1.io)(url, {
        auth: {
            token,
        },
        transports: ['websocket'],
    });
    socket.on('connect', () => {
        process.stdout.write(`connected ${socket.id}\n`);
    });
    socket.on('tracking:ready', (payload) => {
        process.stdout.write(`ready ${JSON.stringify(payload)}\n`);
        if (mode === 'rider') {
            const latitude = Number(args.lat);
            const longitude = Number(args.lng);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                process.stdout.write('rider mode requires --lat and --lng\n');
                return;
            }
            socket.emit('location:update', {
                latitude,
                longitude,
                accuracy: Number(args.accuracy ?? '10'),
                speed: args.speed ? Number(args.speed) : undefined,
                heading: args.heading ? Number(args.heading) : undefined,
                timestamp: new Date().toISOString(),
            }, (response) => {
                process.stdout.write(`ack ${JSON.stringify(response)}\n`);
                socket.close();
            });
        }
    });
    socket.on('tracking:update', (payload) => {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on('tracking:error', (payload) => {
        process.stderr.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on('connect_error', (error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
function parseArgs(entries) {
    const args = {};
    for (let index = 0; index < entries.length; index += 1) {
        const current = entries[index];
        if (!current.startsWith('--')) {
            continue;
        }
        const key = current.slice(2);
        const value = entries[index + 1];
        if (!value || value.startsWith('--')) {
            continue;
        }
        args[key] = value;
    }
    return args;
}
function printUsageAndExit() {
    throw new Error('Usage: npm run tracking:client -- --url http://localhost:3000/tracking --token <jwt> --mode rider|customer [--lat <lat> --lng <lng> --accuracy <metres> --speed <mps> --heading <deg>]');
}
main();
//# sourceMappingURL=tracking-client.js.map