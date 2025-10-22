import { getOrgConfig } from './interactive.ts';
import { listProcesses } from './sync-projects.ts';
import { validateAccess } from './auth.ts';
import inquirer from 'inquirer';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from './config.ts';

async function main() {
    try {
        // Get organization selection from user
        const orgConfig = await getOrgConfig();

        console.log('\nValidating access to organizations...');
        const accessResult = await validateAccess(orgConfig.sourceOrg, orgConfig.targetOrg);
        if (!accessResult.hasAccess) {
            console.error(' Access Error:', accessResult.error);
            console.error('Please check your PAT has sufficient permissions for both organizations.');
            process.exit(1);
        }
        console.log(' Access validated successfully\n');

        // Fetch processes from both organizations
        console.log(`Fetching processes from source organization (${orgConfig.sourceOrg})...`);
        const sourceProcesses = await listProcesses(orgConfig.sourceOrg);
        
        console.log(`Fetching processes from target organization (${orgConfig.targetOrg})...\n`);
        const targetProcesses = await listProcesses(orgConfig.targetOrg);

        // Let user select source process
        const sourceChoices = sourceProcesses.map((p) => ({
            name: `${p.name}${p.isDefault ? ' (Default)' : ''}`,
            value: p.name
        }));

        const { sourceProcess } = await inquirer.prompt([{
            type: 'list',
            name: 'sourceProcess',
            message: `Select the source process to migrate from ${orgConfig.sourceOrg}:`,
            choices: sourceChoices,
            default: sourceProcesses.findIndex((p) => p.isDefault)
        }]);

        // Prompt user to input target process name, defaulting to source process name
        const { targetProcess } = await inquirer.prompt([{
            type: 'input',
            name: 'targetProcess',
            message: `Enter the target process name in ${orgConfig.targetOrg}:`,
            default: sourceProcess
        }]);

        // Update configuration file
        const configPath = join(process.cwd(), 'process-migrator-configuration.json');
    // Use jsonc-parser to allow comments in JSON
    const { parse } = await import('jsonc-parser');
    const existingConfig = parse(readFileSync(configPath, 'utf-8'));
        
        const updatedConfig = {
            ...existingConfig,
            sourceAccountUrl: `https://dev.azure.com/${orgConfig.sourceOrg}`,
            sourceAccountToken: config.AZDO_PAT,
            targetAccountUrl: `https://dev.azure.com/${orgConfig.targetOrg}`,
            targetAccountToken: config.AZDO_PAT,
            sourceProcessName: sourceProcess,
            targetProcessName: targetProcess
        };
        
        writeFileSync(configPath, JSON.stringify(updatedConfig, null, 4));
        console.log('\n Process migrator configuration updated successfully');
        console.log(`  Source: ${orgConfig.sourceOrg} / ${sourceProcess}`);
        console.log(`  Target: ${orgConfig.targetOrg} / ${targetProcess}\n`);
        
    } catch (err) {
        console.error(' Error:', err);
        process.exit(1);
    }
}

main();
