const mediasoup = require('mediasoup');

let worker;

exports.createWorker = async () => {
    worker = await mediasoup.createWorker({
        logLevel:   'warn',
        rtcMinPort: 40000,
        rtcMaxPort: 49999,
    });
    worker.on('died', () => {
        console.error('❌ Mediasoup worker died, exiting in 2s…');
        setTimeout(() => process.exit(1), 2000);
    });
    return worker;
};

exports.createRouter = async (worker) => {
    return await worker.createRouter({
        mediaCodecs: [
            {
                kind:      'audio',
                mimeType:  'audio/opus',
                clockRate: 48000,
                channels:  2
            },
            {
                kind:      'video',
                mimeType:  'video/VP8',
                clockRate: 90000,
                parameters: { 'x-google-start-bitrate': 1000 }
            }
        ]
    });
};

exports.getWorker = () => worker;