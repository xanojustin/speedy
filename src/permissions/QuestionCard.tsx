// U10: AskUserQuestion card. One question at a time (tabs by header when there are several),
// radio or checkbox options per `multiSelect`, plus a free-text "Other". Submitting allows the
// tool call with `answers` added to its input, which is how the CLI receives the user's choices.
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { PendingPermission } from "../store/threadStore";
import { ChoiceCard, useResponder } from "./ChoiceCard";
import { buildAnswers, deny, OTHER, type Question } from "./results";

function questionsOf(input: Record<string, unknown>): Question[] {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  return qs.filter(
    (q): q is Question => !!q && typeof q === "object" && typeof (q as Question).question === "string" && Array.isArray((q as Question).options),
  );
}

function Option({
  multi,
  label,
  description,
  selected,
  onSelect,
  children,
}: {
  multi: boolean;
  label: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
  children?: ReactNode;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!e.repeat) onSelect();
    }
  };
  return (
    <div
      className={`perm-option ${selected ? "perm-option-selected" : ""}`}
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      aria-label={label}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <span className={multi ? "perm-checkbox" : "perm-radio"} aria-hidden>
        {selected && (multi ? <span className="codicon codicon-check" /> : <span className="perm-radio-dot" />)}
      </span>
      <span className="perm-option-content">
        <span className="perm-option-label">{label}</span>
        {description && <span className="perm-option-description">{description}</span>}
        {children}
      </span>
    </div>
  );
}

export function QuestionCard({ threadId, pending }: { threadId: string; pending: PendingPermission }) {
  const { busy, error, respond } = useResponder(threadId, pending.requestId);
  const input = pending.request.input;
  const questions = questionsOf(input);
  const [tab, setTab] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const otherRef = useRef<HTMLInputElement>(null);

  const answers = buildAnswers(questions, picked, other);
  const complete = questions.length > 0 && questions.every((q) => answers[q.question]?.trim());
  const submit = () => void respond({ behavior: "allow", updatedInput: { ...input, answers } });
  const dismiss = () => void respond(deny(""));

  const q = questions[Math.min(tab, questions.length - 1)];

  const toggle = (question: Question, label: string) => {
    const cur = picked[question.question] ?? [];
    let next: string[];
    if (question.multiSelect) next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
    else next = [label];
    setPicked((p) => ({ ...p, [question.question]: next }));
    if (label === OTHER && next.includes(OTHER)) setTimeout(() => otherRef.current?.focus(), 0);
    else if (!question.multiSelect && tab < questions.length - 1) setTab(tab + 1);
  };

  const typeOther = (question: Question, text: string) => {
    setOther((o) => ({ ...o, [question.question]: text }));
    const cur = picked[question.question] ?? [];
    if (text && !cur.includes(OTHER))
      setPicked((p) => ({ ...p, [question.question]: question.multiSelect ? [...cur, OTHER] : [OTHER] }));
  };

  const onTabsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" && tab > 0) setTab(tab - 1);
    else if (e.key === "ArrowRight" && tab < questions.length - 1) setTab(tab + 1);
  };

  return (
    <ChoiceCard
      className="perm-question-card"
      busy={busy}
      error={error}
      onEscape={dismiss}
      choices={[{ label: "Submit answers", onSelect: submit, disabled: !complete }]}
    >
      <div className="perm-question-nav">
        {questions.length > 1 ? (
          <div className="perm-tabs" role="tablist" onKeyDown={onTabsKeyDown}>
            {questions.map((qq, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === tab}
                className={`perm-tab ${i === tab ? "perm-tab-active" : ""} ${answers[qq.question] ? "perm-tab-answered" : ""}`}
                onClick={() => setTab(i)}
              >
                {qq.header || `Question ${i + 1}`}
              </button>
            ))}
          </div>
        ) : (
          <span className="perm-tab perm-tab-active">{q?.header}</span>
        )}
        <span className="perm-spacer" />
        <button type="button" className="perm-close" aria-label="Dismiss" title="Dismiss" disabled={busy} onClick={dismiss}>
          <span className="codicon codicon-close" />
        </button>
      </div>
      {!q ? (
        <div className="perm-header">No questions provided</div>
      ) : (
        <div className="perm-question">
          <div className="perm-question-text">{q.question}</div>
          <div className="perm-options" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
            {q.options.map((o) => (
              <Option
                key={o.label}
                multi={!!q.multiSelect}
                label={o.label}
                description={o.description}
                selected={(picked[q.question] ?? []).includes(o.label)}
                onSelect={() => toggle(q, o.label)}
              />
            ))}
            <Option multi={!!q.multiSelect} label={OTHER} selected={(picked[q.question] ?? []).includes(OTHER)} onSelect={() => toggle(q, OTHER)}>
              <input
                ref={otherRef}
                className="perm-other-input"
                type="text"
                placeholder="Type something else…"
                value={other[q.question] ?? ""}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => typeOther(q, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing && complete) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            </Option>
          </div>
        </div>
      )}
    </ChoiceCard>
  );
}
