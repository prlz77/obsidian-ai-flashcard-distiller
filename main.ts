import {
    App,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
} from "obsidian";
import { initAI, waitForAI, IAIProvider, IAIProvidersService } from "@obsidian-ai-providers/sdk";

interface Settings {
    flashcardRoot: string;
    flashcardTag: string;
    selectedProviderId: string;
    systemPrompt: string;
    excludedFolders: string[];
    fileHeader: string;
}

const DEFAULT_SETTINGS: Settings = {
    flashcardRoot: "Flashcards",
    flashcardTag: "flashcards",
    selectedProviderId: "",
    systemPrompt:
        "You are an expert at extracting spaced repetition flashcards from notes for the Obsidian Spaced Repetition plugin. Be highly selective: only create cards for truly important, long-term memorable content. Output few cards unless the rules require more.\n\n" +
        "Determine the note type first and apply these strict rules:\n\n" +
        "- **Book summary/review**:\n" +
        "  - Always start with **1 concise TL;DR card** for the entire book (core message or 1-2 sentence overview).\n" +
        "  - If the note covers a collection of short stories, fables, tales, parables, essays, chapters, or similar independent pieces: create **EXACTLY ONE flashcard PER distinct story/piece** mentioned. Do NOT skip any, group them, or collapse.\n" +
        "    - For each story card: Use strict multi-line format.\n" +
        "    - Front: \"Summary and key lesson of '[Story Title]'?\"\n" +
        "    - Back structure (no leading empty lines):\n" +
        "      - First line: very brief TL;DR / plot summary of the story itself (exactly 1 concise, non-empty sentence describing what happens).\n" +
        "      - Then immediately: 1-4 bullet points (starting with *) of the most important lessons, themes, morals, insights, or personal takeaways worth remembering forever.\n" +
        "    - If no meaningful 1-sentence plot summary can be made for a story → skip that story card only (very rare; prefer to always include if title is given).\n" +
        "    - Be exhaustive: one card for every distinct story.\n" +
        "  - For study material (e.g. algebra book, language learning): be very sparse, but extract all fundamental concepts/formulas/rules worth remembering forever.\n\n" +
        "- **Journal / personal reflection**: Extremely sparse. Only 1 card if profound forever-worth-remembering realization. Usually: No flashcards extracted.\n\n" +
        "- **Paper / research article review**: Exactly one card. Front: Paper title. Back: 3-6 bullet points of key insights/findings.\n\n" +
        "- **Everything else** (articles, lectures, videos, general notes): 1-4 cards max for core enduring concepts/principles/facts/definitions only.\n\n" +
        "General rules:\n" +
        "- Prioritize long-term value. Be brief, testable, non-redundant. No invention.\n" +
        "- Use multi-line format for stories/lists: Front line ends with ?  \n" +
        "  Then back lines (no blank line immediately after ?).\n" +
        "- Prefer :: for simple single-line Q&A, ::: for reversible, ? for multi-line (back follows directly).\n" +
        "- Bullets must start with * (plugin-friendly).\n" +
        "- If nothing qualifies: output only \"No flashcards extracted.\"\n\n" +
        "Output format (nothing else):\n" +
        "- Cards separated by blank lines.\n" +
        "- Example story card:\n" +
        "Summary and key lesson of \"The Gift of the Magi\"?\n" +
        "A poor young couple each secretly sells their most prized possession to buy a Christmas gift for the other, only to discover the gifts are now useless.\n" +
        "* True love prioritizes selfless intent over practical value.\n" +
        "* The irony of sacrifice: giving up what is cherished can render the gesture pointless.\n" +
        "* Theme: the spirit of giving in the face of poverty.\n\n" +
        "Extract ALL required flashcards following these rules exactly. Output only the cards.",
    excludedFolders: ["Templates"],
    fileHeader: "", // empty = no watermark/header text
};

export default class AIFlashcardDistillerPlugin extends Plugin {
    settings!: Settings;

    async onload() {
        await this.loadSettings();

        initAI(this.app, this, async () => {
            this.addSettingTab(new AIFlashcardDistillerSettingTab(this.app, this));

            this.addCommand({
                id: "generate-flashcards-active-note",
                name: "Generate flashcards for the active note",
                callback: () => {
                    const activeFile = this.app.workspace.getActiveFile();
                    if (activeFile instanceof TFile && activeFile.extension === "md") {
                        this.generateFlashcards(activeFile);
                    } else {
                        new Notice("No active note found");
                    }
                }
            });

            console.log("AI Flashcard Distiller loaded");
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private shouldSkipFile(file: TFile): boolean {
        const root = this.settings.flashcardRoot.replace(/\/$/, "");
        if (file.path.startsWith(root + "/") || file.path === root) {
            return true;
        }

        return this.settings.excludedFolders.some((folder) => {
            const clean = folder.replace(/\/$/, "");
            return file.path === clean || file.path.startsWith(clean + "/");
        });
    }

    private async generateFlashcards(file: TFile) {
        if (this.shouldSkipFile(file)) {
            new Notice("File is in an excluded folder or flashcard root");
            return;
        }

        try {
            const content = await this.app.vault.read(file);
            const tagPrefix = `#${this.settings.flashcardTag}/`;
            if (!content.trim() || content.trim().startsWith(tagPrefix)) {
                new Notice("Skipping: empty or already a flashcard note");
                return;
            }

            const ai = await this.getAIProviders();
            if (!ai) {
                new Notice("AI Providers plugin not available");
                return;
            }

            const provider = this.selectProvider(ai);
            if (!provider) {
                new Notice("No AI provider available");
                return;
            }

            new Notice(`Distilling flashcards • ${file.basename}`);

            const fullPrompt = `${this.settings.systemPrompt}\n\n${content}`;

            let accumulatedText = "";
            const result = await ai.execute({
                provider,
                prompt: fullPrompt,
                onProgress: (_chunk, total) => {
                    accumulatedText = total;
                },
            });

            const text = this.extractResponseText(result, accumulatedText);

            if (!text?.trim()) {
                console.warn("AI Flashcard Distiller: Received empty response from AI", { result, accumulatedText });
                new Notice(`Nothing distilled for ${file.basename} (empty response)`);
                return;
            }

            let clean = text.replace(/^<think>[\s\S]*?<\/think>\s*/i, "").trim();
            const baseTag = `#${this.settings.flashcardTag}`;
            if (clean.startsWith(baseTag)) {
                clean = clean.substring(baseTag.length).trim();
            }

            if (!clean) {
                new Notice(`No flashcards left after cleaning for ${file.basename}`);
                return;
            }

            await this.saveFlashcards(file, clean);
            new Notice(`Flashcards distilled • ${file.basename}`);
        } catch (err: any) {
            console.error("Flashcard distillation failed:", err);
            new Notice(`Failed to distill flashcards: ${err.message || String(err)}`);
        }
    }

    private async getAIProviders(): Promise<IAIProvidersService | null> {
        let ai = (this.app as any).aiProviders as IAIProvidersService | undefined;
        if (ai) return ai;

        try {
            const waiter = await waitForAI();
            return await waiter.promise;
        } catch {
            return null;
        }
    }

    private selectProvider(ai: IAIProvidersService): IAIProvider | null {
        if (this.settings.selectedProviderId) {
            const found = ai.providers.find((p) => p.id === this.settings.selectedProviderId);
            if (found) return found;
        }

        const mainId = (ai as any).plugin?.settings?.aiProviders?.main;
        if (mainId) {
            const found = ai.providers.find((p) => p.id === mainId);
            if (found) return found;
        }

        return ai.providers[0] ?? null;
    }

    private extractResponseText(raw: any, accumulated: string): string | null {
        if (typeof raw === "string" && raw.length > 0) return raw;
        if (accumulated?.length > 0) return accumulated;

        if (raw && typeof raw === "object") {
            const text = raw.text || raw.content || raw.message || raw.response || raw.data || raw.result;
            if (typeof text === "string") return text;

            // Fallback: Force visibility into the object
            return JSON.stringify(raw, null, 2);
        }

        return raw ? String(raw) : null;
    }

    private async saveFlashcards(original: TFile, content: string) {
        const root = this.settings.flashcardRoot.replace(/\/$/, "");
        const targetPath = `${root}/${original.path}`;
        const folderPath = targetPath.split("/").slice(0, -1).join("/");

        // Ensure folders exist recursively
        if (folderPath && !await this.app.vault.adapter.exists(folderPath)) {
            await this.app.vault.createFolder(folderPath).catch(() => { });
        }

        const tag = `#${this.settings.flashcardTag}/${original.path.replace(/\.md$/, "")}`;

        let textToSave = tag + "\n\n";
        if (this.settings.fileHeader.trim()) {
            textToSave += this.settings.fileHeader.trim() + "\n\n";
        }

        const finalContent = textToSave + content;

        const existing = this.app.vault.getAbstractFileByPath(targetPath);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, finalContent);
        } else {
            await this.app.vault.create(targetPath, finalContent);
        }
    }
}

class AIFlashcardDistillerSettingTab extends PluginSettingTab {
    plugin: AIFlashcardDistillerPlugin;

    constructor(app: App, plugin: AIFlashcardDistillerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Flashcard folder")
            .setDesc("Where to store generated flashcard files")
            .addText((text) =>
                text
                    .setPlaceholder("Flashcards")
                    .setValue(this.plugin.settings.flashcardRoot)
                    .onChange(async (v) => {
                        this.plugin.settings.flashcardRoot = v.trim();
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Flashcard tag")
            .setDesc("The tag used to identify flashcard files (e.g. 'flashcards' becomes '#flashcards/')")
            .addText((text) =>
                text
                    .setPlaceholder("flashcards")
                    .setValue(this.plugin.settings.flashcardTag)
                    .onChange(async (v) => {
                        this.plugin.settings.flashcardTag = v.trim().replace(/^#/, "").replace(/\/$/, "");
                        await this.plugin.saveSettings();
                    })
            );

        try {
            const waiter = await waitForAI();
            const ai = await waiter.promise;
            const options: Record<string, string> = { "": "Use default (main)" };

            ai.providers.forEach((p) => {
                options[p.id] = p.name || p.model || p.id;
            });

            new Setting(containerEl)
                .setName("AI Provider")
                .addDropdown((dd) =>
                    dd
                        .addOptions(options)
                        .setValue(this.plugin.settings.selectedProviderId)
                        .onChange(async (v) => {
                            this.plugin.settings.selectedProviderId = v;
                            await this.plugin.saveSettings();
                        })
                );
        } catch {
            new Setting(containerEl).setName("AI Provider").setDesc("AI Providers plugin not detected");
        }

        new Setting(containerEl)
            .setName("System prompt")
            .setDesc("Instructions sent to the model")
            .addTextArea((ta) =>
                ta
                    .setValue(this.plugin.settings.systemPrompt)
                    .setPlaceholder("Default prompt...")
                    .onChange(async (v) => {
                        this.plugin.settings.systemPrompt = v;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Flashcard note watermark")
            .setDesc(
                "Optional text to add at the top of each generated note (after the tag).\n" +
                "Examples: 'Generated by LLM', 'Source note', your name, date, etc.\n" +
                "Leave empty for clean notes with only the tag."
            )
            .addTextArea((ta) =>
                ta
                    .setPlaceholder("Leave blank for no watermark")
                    .setValue(this.plugin.settings.fileHeader)
                    .onChange(async (v) => {
                        this.plugin.settings.fileHeader = v;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Excluded folders")
            .setDesc("Comma-separated — e.g. Templates, Private, Journal")
            .addText((t) =>
                t
                    .setValue(this.plugin.settings.excludedFolders.join(", "))
                    .onChange(async (v) => {
                        this.plugin.settings.excludedFolders = v
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean);
                        await this.plugin.saveSettings();
                    })
            );
    }
}