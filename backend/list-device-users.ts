import { ZKDriver } from './src/lib/zk-driver';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
    const ip = process.env.ZK_HOST || '192.168.1.201'; // Default IP as seen in code
    const port = parseInt(process.env.ZK_PORT || '4370');
    const zk = new ZKDriver(ip, port);

    try {
        console.log(`Connecting to ZKTeco at ${ip}:${port}...`);
        await zk.connect();
        const users = await zk.getUsers();

        console.log('--- Device Users List ---');
        console.log(`Total Users on Device: ${users.length}`);
        console.log('-------------------------');

        users.sort((a: any, b: any) => parseInt(a.userId) - parseInt(b.userId));

        users.forEach((u: any) => {
            console.log(`UID: ${String(u.uid).padEnd(4)} | userId: ${String(u.userId).padEnd(6)} | Name: ${u.name}`);
        });
        console.log('-------------------------');

    } catch (error: any) {
        console.error('Connection/Fetch Error:', error.message);
    } finally {
        await zk.disconnect();
    }
}

main();
