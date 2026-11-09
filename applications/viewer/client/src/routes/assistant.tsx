import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import {
  answerAssistantAction,
  ApiError,
  clearAssistant,
  fetchAssistant,
  sendAssistantMessage,
  type AssistantAction,
  type AssistantChat,
  type AssistantMessage,
} from '../api/client.ts';
import { AccountBar } from '../components/account-bar.tsx';
import { PublicHeader } from '../components/public-header.tsx';
import { Button } from '../components/states.tsx';
import type { AuthState } from '../lib/use-auth.ts';

const SUGGESTIONS = [
  'How are my projects doing?',
  'Warn me when CPU goes above 80 and alert above 95',
  'Which thresholds do I have?',
];

const TITLES: Record<AssistantAction['status'], string> = {
  done: 'Done',
  exists: 'Already there',
  skipped: 'Not done',
  pending: 'Waiting for your yes',
  declined: 'Left as it was',
};

function ActionCard({
  action,
  onAnswer,
}: {
  action: AssistantAction;
  onAnswer?: (decision: 'confirm' | 'decline') => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const answer = (decision: 'confirm' | 'decline') => {
    if (!onAnswer) return;
    setBusy(true);
    void onAnswer(decision).finally(() => setBusy(false));
  };
  return (
    <li className="enter rounded-md border border-line bg-surface px-3 py-2 text-body">
      <p className="text-ink-3 text-sm">
        {action.type === 'create_threshold' ? 'Threshold' : 'Remove threshold'} ·{' '}
        {TITLES[action.status]}
      </p>
      <p className="text-ink">{action.label}</p>
      {action.detail ? <p className="text-ink-2 text-sm">{action.detail}</p> : null}
      {action.status === 'pending' && onAnswer ? (
        <div className="mt-2 flex gap-2">
          <Button onClick={() => answer('confirm')} disabled={busy}>
            Do it
          </Button>
          <Button onClick={() => answer('decline')} disabled={busy}>
            Keep as it is
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function Bubble({
  message,
  onAnswer,
}: {
  message: AssistantMessage;
  onAnswer: (
    message: AssistantMessage,
    index: number,
    decision: 'confirm' | 'decline',
  ) => Promise<void>;
}) {
  const mine = message.role === 'user';
  return (
    <div className={`enter flex flex-col gap-2 ${mine ? 'items-end' : 'items-start'}`}>
      <p
        className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-body ${
          mine ? 'bg-accent text-accent-ink' : 'border border-line bg-raised text-ink'
        }`}
      >
        {message.content}
      </p>
      {message.actions.length > 0 ? (
        <ul className="flex w-full max-w-[85%] flex-col gap-2" aria-label="What I did">
          {message.actions.map((action, index) => (
            <ActionCard
              key={index}
              action={action}
              onAnswer={(decision) => onAnswer(message, index, decision)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** `/assistant` - talk to the language model that reads your projects and manages their alert thresholds. */
export default function AssistantRoute() {
  const auth = useOutletContext<AuthState>();
  const [chat, setChat] = useState<AssistantChat | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (auth.status !== 'signed-in') return;
    const controller = new AbortController();
    fetchAssistant(controller.signal)
      .then(setChat)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(
          cause instanceof ApiError ? cause.message : 'The assistant could not be loaded.',
        );
      });
    return () => controller.abort();
  }, [auth.status]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [chat?.messages.length, sending]);

  if (auth.status === 'loading')
    return (
      <>
        <PublicHeader />
        <main className="page flex-1 py-16">
          <p role="status" className="text-body text-ink-2">
            Checking your session…
          </p>
        </main>
      </>
    );
  if (auth.status !== 'signed-in' || !auth.user)
    return (
      <>
        <PublicHeader />
        <main className="page flex-1 py-16">
          <p className="text-body text-ink-2">
            <Link to="/">Sign in</Link> to use the assistant.
          </p>
        </main>
      </>
    );

  const send = (message: string) => {
    const clean = message.trim();
    if (!clean || sending || !chat) return;
    const now = new Date().toISOString();
    setChat({
      ...chat,
      messages: [
        ...chat.messages,
        { id: -Date.now(), role: 'user', content: clean, actions: [], createdAt: now },
      ],
    });
    setText('');
    setSending(true);
    setError(null);
    sendAssistantMessage(clean, new AbortController().signal)
      .then((reply) => setChat((c) => (c ? { ...c, messages: [...c.messages, reply] } : c)))
      .catch((cause: unknown) =>
        setError(cause instanceof ApiError ? cause.message : 'The assistant did not answer.'),
      )
      .finally(() => setSending(false));
  };

  const answer = async (
    message: AssistantMessage,
    index: number,
    decision: 'confirm' | 'decline',
  ) => {
    try {
      const result = await answerAssistantAction(
        message.id,
        index,
        decision,
        new AbortController().signal,
      );
      setChat((c) =>
        c
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === message.id
                  ? { ...m, actions: m.actions.map((a, i) => (i === index ? result : a)) }
                  : m,
              ),
            }
          : c,
      );
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That did not work.');
    }
  };

  const clear = () => {
    clearAssistant(new AbortController().signal)
      .then(() => setChat((c) => (c ? { ...c, messages: [] } : c)))
      .catch(() => setError('The chat could not be cleared.'));
  };

  const offline = chat !== null && (!chat.enabled || !chat.ready);

  return (
    <>
      <AccountBar email={auth.user.email} onSignedOut={auth.refresh}>
        <Link to="/" className="text-ink-2 hover:text-ink">
          Projects
        </Link>
      </AccountBar>
      <main className="page flex flex-1 flex-col gap-4 py-6">
        <header className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-heading text-ink">Assistant</h1>
            <p className="text-body text-ink-2">
              Ask how your projects are doing, or tell it which alerts to set. It runs on this
              server; nothing you write leaves it.
            </p>
          </div>
          {chat && chat.messages.length > 0 ? <Button onClick={clear}>Clear chat</Button> : null}
        </header>

        {loadError ? (
          <p role="alert" className="text-text-danger text-body">
            {loadError}
          </p>
        ) : null}
        {!chat && !loadError ? (
          <p role="status" className="text-body text-ink-2">
            Loading the chat…
          </p>
        ) : null}
        {offline ? (
          <p
            role="status"
            className="rounded-md border border-line bg-raised px-3 py-2 text-body text-ink-2"
          >
            The assistant is not running right now.
          </p>
        ) : null}

        {chat ? (
          <section
            aria-label="Conversation with the assistant"
            className="flex min-h-[40vh] flex-1 flex-col gap-4"
          >
            {chat.messages.length === 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-body text-ink-2">Try one of these, or write your own.</p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <Button key={s} onClick={() => send(s)} disabled={offline || sending}>
                      {s}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
            {chat.messages.map((m) => (
              <Bubble key={m.id} message={m} onAnswer={answer} />
            ))}
            {sending ? (
              <p role="status" className="text-ink-3 text-body">
                Thinking…
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-text-danger text-body">
                {error}
              </p>
            ) : null}
            <div ref={end} />
          </section>
        ) : null}

        <form
          className="sticky bottom-(--footer-h) flex gap-2 bg-bg py-2"
          onSubmit={(event) => {
            event.preventDefault();
            send(text);
          }}
        >
          <label className="sr-only" htmlFor="assistant-input">
            Message the assistant
          </label>
          <input
            id="assistant-input"
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 text-body text-ink"
            placeholder="Ask or tell the assistant…"
            value={text}
            maxLength={1000}
            disabled={offline || sending}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" disabled={offline || sending || text.trim() === ''}>
            Send
          </Button>
        </form>
      </main>
    </>
  );
}
