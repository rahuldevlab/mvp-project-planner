import React, { useState } from 'react';
import { Check, Copy, Download, Sparkles, Trash2 } from 'lucide-react';
import type {
  AdminDraft,
  AdminDraftKind,
  ProjectBlueprint,
  ScheduleBlock,
  Sprint,
  TaskItem,
} from '../types/workspace';
import { createId } from '../utils/scheduleUtils';

interface AdminDraftsViewProps {
  blueprint: ProjectBlueprint;
  sprints: Sprint[];
  tasks: TaskItem[];
  scheduleBlocks: ScheduleBlock[];
  activeDate: string;
  drafts: AdminDraft[];
  onAddDraft: (draft: AdminDraft) => void;
  onUpdateDraft: (draftId: string, content: string) => void;
  onDeleteDraft: (draftId: string) => void;
  onNotify: (message: string, tone?: 'info' | 'error') => void;
}

const DRAFT_KINDS: { kind: AdminDraftKind; label: string; hint: string }[] = [
  {
    kind: 'standup',
    label: 'Daily Standup Digest',
    hint: 'Completed yesterday, today focus across sprint & general tasks, and schedule risks.',
  },
  {
    kind: 'stakeholder_update',
    label: 'Stakeholder Sprint Brief',
    hint: 'Executive summary of sprint velocity, MVP readiness, and upcoming milestones.',
  },
  {
    kind: 'follow_up_email',
    label: 'Admin Follow-Up Email',
    hint: 'Actionable follow-up message for pending operational, vendor, or team items.',
  },
  {
    kind: 'meeting_agenda',
    label: 'Sync / Review Agenda',
    hint: 'Time-boxed agenda covering active blockers, architecture decisions, and next actions.',
  },
];

export const AdminDraftsView: React.FC<AdminDraftsViewProps> = ({
  blueprint,
  sprints,
  tasks,
  scheduleBlocks,
  activeDate,
  drafts,
  onAddDraft,
  onUpdateDraft,
  onDeleteDraft,
  onNotify,
}) => {
  const [selectedKind, setSelectedKind] = useState<AdminDraftKind>('standup');
  const [customInstructions, setCustomInstructions] = useState('');
  const [generating, setGenerating] = useState(false);
  const [activeDraftId, setActiveDraftId] = useState<string>(drafts[0]?.id || '');
  const [copied, setCopied] = useState(false);

  const activeDraft = drafts.find((d) => d.id === activeDraftId) || drafts[0] || null;

  async function handleGenerateDraft() {
    setGenerating(true);
    try {
      const res = await fetch('/api/agent/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: selectedKind,
          customInstructions,
          blueprint,
          sprints,
          tasks,
          scheduleBlocks: scheduleBlocks.filter((b) => b.date === activeDate),
          activeDate,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate draft');

      const newDraft: AdminDraft = {
        id: createId('drf'),
        kind: selectedKind,
        title: data.title || `${selectedKind} — ${activeDate}`,
        content: data.content || '',
        createdAt: new Date().toISOString(),
        sourceSnapshotSummary:
          data.sourceSnapshotSummary || `Generated from ${tasks.length} tasks`,
      };
      onAddDraft(newDraft);
      setActiveDraftId(newDraft.id);
      onNotify('Admin draft generated');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Draft generation failed', 'error');
    } finally {
      setGenerating(false);
    }
  }

  async function handleCopy() {
    if (!activeDraft) return;
    try {
      await navigator.clipboard.writeText(activeDraft.content);
      setCopied(true);
      onNotify('Copied draft to clipboard');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      onNotify('Clipboard access blocked by browser', 'error');
    }
  }

  function handleDownloadMd() {
    if (!activeDraft) return;
    const blob = new Blob([`# ${activeDraft.title}\n\n${activeDraft.content}\n`], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeDraft.kind}_${activeDate}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-[1360px] space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#212836] pb-5">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[#F1F5F9]">
            Daily Admin & Standup Automations
          </h1>
          <p className="text-xs text-[#8B949E]">
            Synthesize standup digests, stakeholder briefs, and follow-up emails directly from your live sprint tasks, general inbox, and daily schedule.
          </p>
        </div>
      </div>

      {/* Generator Controls */}
      <section className="rounded-lg border border-[#212836] bg-[#121720] p-5 space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {DRAFT_KINDS.map((item) => (
            <button
              key={item.kind}
              type="button"
              onClick={() => setSelectedKind(item.kind)}
              className={`rounded-md border p-3 text-left transition-colors ${
                selectedKind === item.kind
                  ? 'border-[#3B82F6] bg-[#17253B]'
                  : 'border-[#212836] bg-[#090C10] hover:bg-[#151B26]'
              }`}
            >
              <div className="text-xs font-semibold text-[#F1F5F9]">{item.label}</div>
              <div className="mt-1 text-[11px] leading-snug text-[#8B949E]">{item.hint}</div>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={customInstructions}
            onChange={(e) => setCustomInstructions(e.target.value)}
            placeholder="Optional tone or recipient note (e.g., Address to CTO, emphasize SSL renewal & Sprint 0 progress)..."
            className="min-w-[260px] flex-1 rounded-md border border-[#212836] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#6E7681] focus:border-[#3B82F6] focus:outline-none"
          />
          <button
            type="button"
            onClick={handleGenerateDraft}
            disabled={generating}
            className="inline-flex items-center gap-2 rounded-md bg-[#3B82F6] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {generating ? 'Synthesizing Draft...' : 'Generate Draft'}
          </button>
        </div>
      </section>

      {/* Draft History + Editor */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <aside className="space-y-2 lg:col-span-4">
          <h2 className="font-display text-sm font-semibold text-[#F1F5F9]">
            Session Drafts ({drafts.length})
          </h2>
          {drafts.length === 0 ? (
            <div className="rounded-lg border border-[#212836] bg-[#121720] p-6 text-xs text-[#8B949E]">
              No drafts generated yet. Pick a template above to generate your first digest.
            </div>
          ) : (
            <div className="divide-y divide-[#212836] rounded-lg border border-[#212836] bg-[#121720]">
              {drafts.map((draft) => (
                <div
                  key={draft.id}
                  className={`flex items-start justify-between gap-2 p-3.5 transition-colors ${
                    activeDraft?.id === draft.id ? 'bg-[#181E29]' : 'hover:bg-[#151B26]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveDraftId(draft.id)}
                    className="min-w-0 flex-1 text-left space-y-1"
                  >
                    <div className="truncate text-xs font-medium text-[#F1F5F9]">
                      {draft.title}
                    </div>
                    <div className="text-[11px] text-[#8B949E]">
                      {draft.kind.replace('_', ' ')} · {draft.sourceSnapshotSummary}
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete draft"
                    onClick={() => onDeleteDraft(draft.id)}
                    className="rounded p-1 text-[#6E7681] hover:text-[#F87171]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section className="lg:col-span-8">
          {activeDraft ? (
            <div className="rounded-lg border border-[#212836] bg-[#121720] p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#212836] pb-3">
                <div>
                  <h2 className="font-display text-base font-semibold text-[#F1F5F9]">
                    {activeDraft.title}
                  </h2>
                  <p className="font-mono text-[11px] tabular-nums text-[#8B949E]">
                    {activeDraft.sourceSnapshotSummary}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDownloadMd}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#2E3748] bg-[#090C10] px-3 py-1.5 text-xs text-[#F1F5F9] hover:bg-[#181E29]"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export .md
                  </button>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#3B82F6] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#2563EB]"
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? 'Copied' : 'Copy Text'}
                  </button>
                </div>
              </div>

              <textarea
                rows={14}
                value={activeDraft.content}
                onChange={(e) => onUpdateDraft(activeDraft.id, e.target.value)}
                className="w-full rounded-md border border-[#212836] bg-[#090C10] p-4 font-mono text-xs leading-relaxed text-[#F1F5F9] focus:border-[#3B82F6] focus:outline-none"
              />
            </div>
          ) : (
            <div className="rounded-lg border border-[#212836] bg-[#121720] p-12 text-center text-xs text-[#8B949E]">
              Select or generate a draft to inspect and edit it here.
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
