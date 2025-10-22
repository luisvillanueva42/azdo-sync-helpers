import { getProjectConfig } from './interactive.ts';
import { 
    copyProjectsFromSourceToTarget, 
    listProcesses,
    listProjects,
    type ProjectAction 
} from './sync-projects.ts';
import { validateAccess } from './auth.ts';
import inquirer from 'inquirer';

interface Project {
    id: string;
    name: string;
}

async function main() {
    try {
        const cfg = await getProjectConfig();

        console.log('\nValidating access to organizations...');
        const accessResult = await validateAccess(cfg.sourceOrg, cfg.targetOrg);
        if (!accessResult.hasAccess) {
            console.error('❌ Access Error:', accessResult.error);
            console.error('Please check your PAT has sufficient permissions for both organizations.');
            process.exit(1);
        }
        console.log('✓ Access validated successfully\n');

        // Fetch available processes from the target org
        console.log(`\nFetching available processes from ${cfg.targetOrg}...`);
        const processes = await listProcesses(cfg.targetOrg);
        const defaultProcess = processes.find(p => p.isDefault);
        const procChoices = processes.map((p) => ({ 
            name: `${p.name}${p.isDefault ? ' (Default)' : ''}`, 
            value: p.name 
        }));

        // Get existing projects to check for conflicts
        const [sourceProjects, targetProjects] = await Promise.all([
            listProjects(cfg.sourceOrg),
            listProjects(cfg.targetOrg)
        ]);

        // Find projects that exist in both orgs
        const existingProjects = sourceProjects.filter((sp: Project) => 
            targetProjects.some((tp: Project) => tp.name.toLowerCase() === sp.name.toLowerCase())
        );

        let projectActions: ProjectAction[] = [];

        // If there are existing projects, ask what to do with them
        if (existingProjects.length > 0) {
            console.log('\nSome projects already exist in the target organization:');
            existingProjects.forEach((p: Project) => console.log(`  • ${p.name}`));

            const { skipExisting } = await inquirer.prompt([{
                type: 'confirm',
                name: 'skipExisting',
                message: 'Do you want to skip these existing projects? (No will delete and recreate them)',
                default: true
            }]);

            // Set actions based on user choice
            projectActions = sourceProjects.map((sp: Project) => ({
                projectId: sp.id,
                projectName: sp.name,
                action: existingProjects.some((ep: Project) => ep.name.toLowerCase() === sp.name.toLowerCase())
                    ? (skipExisting ? 'skip' : 'recreate')
                    : 'create'
            }));
        }

        const { selectedProcess } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedProcess',
                message: `Select the target process to use when creating projects in ${cfg.targetOrg}:`,
                choices: procChoices,
                default: processes.findIndex((p) => p.isDefault)
            }
        ]);

        await copyProjectsFromSourceToTarget(
            cfg.sourceOrg, 
            cfg.targetOrg, 
            cfg.dryRun, 
            selectedProcess,
            projectActions
        );
    } catch (err) {
        console.error('❌ Error:', err);
        process.exit(1);
    }
}

main();