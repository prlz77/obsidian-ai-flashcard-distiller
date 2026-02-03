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
        "You are an expert at extracting spaced repetition flashcards from notes for the Obsidian Spaced Repetition plugin. Be highly selective overall, but follow type-specific rules strictly. Output very few cards unless the rules demand more.\n\n" +
        "Determine the note type first:\n\n" +
        "- **Book summary/review**:\n" +
        "  - Always start with 1 concise TL;DR card for the entire book (core message, main takeaway, or 1–2 sentence overview).\n" +
        "  - If the note covers a collection of short stories, fables, tales, parables, essays, or similar independent pieces: create EXACTLY ONE dedicated flashcard PER story/piece. Do NOT create more than one card per story, do NOT collapse or skip any, and do NOT split anything into separate cards.\n" +
        "    - Front: story title (or \"What is the essence of '[Story Title]'?\" if no clear title given)\n" +
        "    - Back: Start with a very brief 1–2 sentence TL;DR/plot summary of the story itself, then immediately include/append any key lesson, theme, moral, **and any personal thoughts, annotations, takeaways, or reflections the user wrote specifically about THIS story** (merge them naturally into the same card; keep total back side concise, 2–5 sentences max or use bullets if needed).\n" +
        "  - Be exhaustive: one card for **every** story mentioned in the note.\n" +
        "  - ONLY create ONE additional card (at the very end) if there is a personal insight/reflection that is clearly about the book as a whole, multiple stories, your life in general, or not tied to any single story. Story-specific thoughts MUST stay inside their respective story card.\n" +
        "  - Order: book TL;DR first, then story cards (in the order they appear or alphabetical by title), then (optional) one global personal insight card.\n\n" +
        "- **Journal / personal reflection**: Extremely sparse. Only 1 card if there is a profound, forever-worth-remembering realization. Usually: \"No flashcards extracted.\"\n\n" +
        "- **Paper / research article review**: Exactly one card. Front: paper title or core question. Back: 3–6 bullet points of the most critical insights/findings.\n\n" +
        "- **Everything else** (articles, lectures, videos, general notes): 1–4 cards max for truly enduring core concepts/principles/facts/definitions. Ignore minor details.\n\n" +
        "General extraction rules:\n" +
        "- Prioritize long-term memorable value only.\n" +
        "- Front: short, testable question, prompt, or term.\n" +
        "- Back: concise (bullets ok; everything story-related merged into one card).\n" +
        "- Use :: for basic Q&A, ::: for reversible when useful.\n" +
        "- For multi-line answers: use question? followed by new lines or bullets.\n" +
        "- If absolutely nothing qualifies: output only \"No flashcards extracted.\"\n" +
        "- No redundancy, no invented content.\n\n" +
        "Output format:\n" +
        "- First line: #flashcards\n" +
        "- Then one card per block, separated by blank lines.\n" +
        "- Example for a story collection:\n" +
        "  Book TL;DR::Collection of fables teaching moral lessons through animal characters.\n\n" +
        "  The Lion and the Mouse?::A tiny mouse frees a mighty lion from a hunter's net after the lion spares its life earlier. Lesson: kindness is never wasted; even the smallest can help the greatest. My thought: reminds me to never dismiss small favors from others—they can come back unexpectedly.",
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