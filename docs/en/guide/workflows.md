# Workflows

Save a reliable division of work as a workflow and reuse it in any room. You can install a bundled workflow or create and edit your own with the workflow-creator skill.

## How to use workflows

### 1. Install bundled workflows

The CoDiscuss package includes three workflows. They are not installed by default:

- **“小说连载”** (serial fiction, `story-serial`): a screenwriter, writer, two critics, and a recorder work through each episode in sequence. A reader can review the draft when needed. Includes templates and check scripts that require Python and PyYAML.
- **“决策会审”** (decision council, `decision-council`): a devil’s advocate, outsider, alternative thinker, and implementer respond independently, then debate disagreements. The host synthesizes a recommendation.
- **“经典跑团（龙与地下城式）”** (classic tabletop role-playing, `trpg-classic`): a dungeon master and three AI players, with rules reference, an original adventure, and dice scripts that require Python.

To install workflows for the first time or add them later:

- **Interactive setup:** Run codiscuss setup. After choosing software, expand “Bundled workflows” with the Right Arrow at “Install settings,” select workflows with Space, and continue with Enter.
- **Install all bundled workflows:** Run codiscuss setup --workflows or codiscuss install --workflows.

Rerunning setup replaces selected bundled workflows with the package versions. Before replacing a workflow with the same ID, the original is backed up under backups/workflows/ in the local service directory. Custom workflows with different IDs and your software and site settings are left alone. Workflow selections apply only to that run and are not remembered.

### 2. Enable, refresh, and end a room workflow

1. **Allow the host to enable workflows:** When creating a room, turn on “Full host control” under “How to work (optional)”. In an existing room, open **Room → Members and settings** in the left sidebar and turn it on under “Collaboration settings.” The host then has permission to enable a workflow and invite its members.
2. **Enable a workflow:** Type / in the composer, choose a saved workflow, add what you want done, and send the message to the host. The composer inserts /workflow-id. The host enables it, adds any missing workflow members, and assigns work according to the workflow.
   - Each card in the main workflow defines a role, including its description, member prompt, software, model, effort, and project access. Members already mapped to a card and present in the room keep their identity. Away members are invited back. Sub-workflow roles join when used. Workflow prompts are read-only in a room. Edit them on the Workflows page.
3. **Add new roles:** If you add cards to a workflow later, existing rooms do not add those members automatically. The host adds them when needed, or you can click the refresh icon on the workflow row in the right panel.
4. **Use a sub-workflow:** While a workflow is active, type / in the composer and choose an item under “Sub-workflows of ‘name’.” Send it to the host to run that procedure. Members used only by the sub-workflow are marked away when it is done. Their sessions are kept.
5. **End a workflow in a room:** On the workflow row under “Collaboration settings” in **Room → Members and settings** in the left sidebar, click the dismiss-members control. Workflow members leave, the host stays, and active work stops. Their sessions are kept, and selecting that workflow again can bring the members back. To disable a workflow in your local library, open the “…” menu beside it on the Workflows page and choose “Disable.”

### 3. Create or edit workflows with workflow-creator

You can create or import a ZIP file or folder with the “+” on the Workflows page. You can also ask an AI with the bundled workflow-creator skill to draft and validate a workflow:

- **Ask the host in a room:** Enable “Full host control,” then describe the division of work you want. You can also type / and choose “Create / edit workflow” under platform skills. The host uses the skill to create SKILL.md, role cards, and a canvas, validates them, saves, and enables the workflow.
- **Ask an AI in an external session:** In a Claude Code or Codex session with the CoDiscuss skills installed, ask it to create or edit a workflow with workflow-creator. It validates a folder with codiscuss launch workflow-check --dir <directory>. After you approve, it saves the workflow with codiscuss launch workflow-save --dir <directory>. Saving an existing ID replaces that workflow.
- **Where workflows are stored:** The local service keeps them under ~/.codiscuss/workflows/<workflow-id>/. On the Workflows page, open the “…” menu and choose “Copy folder path” to locate or share one.

### 4. The canvas and SKILL.md

Select a workflow on the Workflows page. The canvas opens in the center, and its SKILL.md appears on the right. Click “Edit,” then “Save” or press Ctrl+S to save changes.

- **The canvas is a diagram:** You can move cards, add host nodes, connect nodes to show order or loops, add notes to connections, or choose “Auto arrange.” Click a connection or its note to select it before editing; once a gold loop is selected, drag it up or down to change its height. Dragging an unselected connection or note just pans the canvas. The program does not execute canvas connections, and the host cannot see the canvas.
- **The host follows SKILL.md:** The skill file defines order, parallel work, when to return to the host, and when to revise. The host follows those written instructions. When workflow-creator creates or edits a workflow, it updates the canvas to reflect the skill file.

### 5. “Full host control” and workflows

- With “Full host control,” the host can create, edit, and enable workflows, invite required members with up to write access, interrupt or retry members, change models, reorder speakers, withdraw its own assignments, start discussions or Goals, and schedule its own check-ins.
- Without this setting, workflow items in the composer’s / menu are disabled. The host cannot invite members or enable a workflow. You can invite the members yourself and explain the process to the host.
- Enabling a new workflow through the composer requires a host that the local service can wake. An API host can read the description and role list for an enabled workflow.

## Things to know

- **Changes reach active rooms:** Rooms using a workflow read its latest instructions and member prompts on their next run. Existing members’ models, effort, and project access remain room settings.
- **Review imported workflows:** Importing a ZIP or folder shows a canvas preview. Cards that can write files are imported read-only until you enable them individually. If a workflow includes commands.json to register local commands for read-only API members, the editor shows the full commands. They run only after you enable “Allow these commands to run on this computer.” The host cannot add or remove local commands while drafting or editing a workflow.
- **You keep key decisions:** Even with “Full host control,” only you can change the host, approve assignment rounds above the limit, grant project access above write, change project folders, withdraw your messages, or use private chat.
