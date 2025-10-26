import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from './config.ts';
import inquirer from 'inquirer';
import { writeFileSync, readFileSync } from 'fs';

// API Version
export const API_VER = '7.1';

// Simple progress indicator
export function startProgress(message: string): NodeJS.Timeout {
    process.stdout.write(`${message} `);
    let dots = 0;
    return setInterval(() => {
        process.stdout.write('.');
        dots++;
        if (dots >= 3) {
            process.stdout.write('\b\b\b   \b\b\b');
            dots = 0;
        }
    }, 500);
}

export function stopProgress(timer: NodeJS.Timeout, successMessage: string): void {
    clearInterval(timer);
    process.stdout.write(`\r${successMessage}\n`);
}

// Helper function to ensure valid PAT
export async function ensureValidPAT(org: string): Promise<string> {
    let pat = config.AZDO_PAT;
    
    if (!pat) {
        const answer = await inquirer.prompt([
            {
                type: 'password',
                name: 'pat',
                message: 'Enter your Azure DevOps Personal Access Token (PAT):',
                mask: '*'
            }
        ]);
        pat = answer.pat;
    }

    // Test PAT against the organization
    const AUTH = 'Basic ' + Buffer.from(':' + pat).toString('base64');
    const headers = { Authorization: AUTH };
    
    try {
        const url = new URL(`https://dev.azure.com/${org}/_apis/work/processes`);
        url.searchParams.set('api-version', API_VER);
        const res = await fetch(url, { headers });
        
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                const answer = await inquirer.prompt([
                    {
                        type: 'password',
                        name: 'pat',
                        message: 'Invalid PAT. Enter a valid Azure DevOps Personal Access Token (PAT):',
                        mask: '*'
                    }
                ]);
                pat = answer.pat;
                
                const newAuth = 'Basic ' + Buffer.from(':' + pat).toString('base64');
                const newHeaders = { Authorization: newAuth };
                const newRes = await fetch(url, { headers: newHeaders });
                
                if (!newRes.ok) {
                    throw new Error(`PAT is still invalid for organization ${org}. Status: ${newRes.status}`);
                }
            } else {
                throw new Error(`Error accessing ${org}: ${res.status} ${res.statusText}`);
            }
        }
    } catch (err) {
        if (err instanceof Error && err.message.includes('PAT is still invalid')) {
            throw err;
        }
        throw new Error(`Network error accessing ${org}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Save PAT to config.ts if it was newly provided or changed
    if (pat !== config.AZDO_PAT && pat) {
        try {
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = dirname(__filename);
            const configPath = join(__dirname, 'config.ts');
            let configText = readFileSync(configPath, 'utf-8');
            configText = configText.replace(/AZDO_PAT:\s*['\"][^'\"]*['\"]/, `AZDO_PAT: '${pat}'`);
            writeFileSync(configPath, configText);
            config.AZDO_PAT = pat;
        } catch (err) {
            console.warn('Warning: Could not update config.ts with new PAT:', err);
        }
    }

    return pat;
}

// Get headers with valid PAT
export async function getHeaders(org: string): Promise<{ Authorization: string }> {
    const pat = await ensureValidPAT(org);
    const AUTH = 'Basic ' + Buffer.from(':' + pat).toString('base64');
    return { Authorization: AUTH };
}

export async function getHeadersJson(org: string): Promise<{ Authorization: string; 'Content-Type': string }> {
    const headers = await getHeaders(org);
    return { ...headers, 'Content-Type': 'application/json' };
}