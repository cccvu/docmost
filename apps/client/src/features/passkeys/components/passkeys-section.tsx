import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Alert,
  Button,
  Divider,
  Skeleton,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useTranslation } from "react-i18next";
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode.ts";
import { passkeyUiAction, toPasskeyFailure } from "../lib/passkey-errors.ts";
import {
  listPasskeys,
  signalAcceptedPasskeys,
} from "../services/passkey-api.ts";
import type { PasskeyListResponse, PasskeyView } from "../types.ts";
import { AddPasskeyButton } from "./add-passkey-button.tsx";
import { passkeyDate, passkeyName } from "./passkey-format.ts";
import {
  passkeyFocusTarget,
  type PasskeyFocusReturn,
} from "./passkey-focus.ts";
import { PasskeyList } from "./passkey-list.tsx";
import { RemovePasskeyDialog } from "./remove-passkey-dialog.tsx";

// wiki-v2 #818 — NOT upstream Docmost code. Profile → Passkeys, mounted after Sessions by the one-line seam in
// pages/settings/account/account-settings.tsx (UPSTREAM_MODIFICATIONS.md #44). It renders its own divider, and
// nothing at all when there is no platform (native mode) or the platform has no passkey routes (404/405 from an
// older platform task during a rolling deploy).
//
// The browser is told which credentials still work (`signalAllAcceptedCredentials`) ONLY from a list the platform
// just answered: never from an empty list after an error, which would make it hide every passkey.
//
// Closing the remove dialog puts focus back on purpose (#907, passkey-focus.ts): the row button, else the row's
// current action, else the Passkeys heading; after a removal or a 404, the heading.

export default function PasskeysSection() {
  // Passkeys are the platform's: a standalone (native) engine has none.
  if (isNativeAuthEnabled()) return null;
  return <PasskeysPanel />;
}

function isPast(iso: string): boolean {
  const at = Date.parse(iso);
  return Number.isFinite(at) && at <= Date.now();
}

function PasskeysPanel() {
  const { t } = useTranslation();
  const headingId = useId();
  const [hidden, setHidden] = useState(false);
  const [list, setList] = useState<PasskeyListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PasskeyView | null>(null);
  const returnFocus = useRef<PasskeyFocusReturn | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loadSeq = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // setState only in the promise callbacks: never synchronously inside the effect that starts the load.
  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    const current = () => mounted.current && seq === loadSeq.current;
    return listPasskeys().then(
      (next) => {
        if (!current()) return;
        setList(next);
        setLoadError(null);
        signalAcceptedPasskeys(next);
      },
      (failure: unknown) => {
        if (!current()) return;
        const action = passkeyUiAction("list", toPasskeyFailure(failure), t);
        if (action.kind === "hide") {
          setHidden(true);
          return;
        }
        setLoadError(
          action.kind === "message"
            ? action.message
            : t("Something went wrong. Try again."),
        );
      },
    );
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // The dialog has just unmounted (and taken the focused element with it): focus its trigger or a fallback.
  useEffect(() => {
    const pending = returnFocus.current;
    if (removing !== null || !pending) return;
    returnFocus.current = null;
    passkeyFocusTarget(
      pending,
      sectionRef.current,
      headingRef.current,
    )?.focus();
  }, [removing]);

  const closeRemove = (rowGone: boolean) => {
    if (rowGone && returnFocus.current) returnFocus.current.toHeading = true;
    setRemoving(null);
  };

  if (hidden) return null;

  const live = list?.passkeys.filter((p) => !p.removalPending) ?? [];

  return (
    <>
      <Divider my="lg" />
      <section aria-labelledby={headingId} ref={sectionRef}>
        <Stack gap="sm">
          <Title
            order={2}
            size="h4"
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
          >
            {t("Passkeys")}
          </Title>
          <Text size="sm" c="dimmed">
            {t(
              "A passkey lets you sign in with your fingerprint, face or device PIN instead of a code from your email. It still works when email is down.",
            )}
          </Text>

          {list && live.length > 0 && (
            <WorksUntil passkeysWorkUntil={list.passkeysWorkUntil} />
          )}

          <div aria-live="polite">
            {notice && <Text size="sm">{notice}</Text>}
          </div>

          {loadError && (
            <Alert color="red" variant="light" role="alert">
              <Stack gap="xs" align="flex-start">
                <Text size="sm">{loadError}</Text>
                <Button variant="default" size="xs" onClick={() => void load()}>
                  {t("Try again")}
                </Button>
              </Stack>
            </Alert>
          )}

          {!list && !loadError && (
            <Skeleton height={40} radius="sm" aria-hidden="true" />
          )}

          {list && (
            <>
              <PasskeyList
                passkeys={list.passkeys}
                onRemove={(p, trigger) => {
                  setNotice(null);
                  returnFocus.current = {
                    trigger,
                    passkeyId: p.id,
                    toHeading: false,
                  };
                  setRemoving(p);
                }}
              />
              <AddPasskeyButton
                onAdded={() => {
                  setNotice(t("Passkey added."));
                  void load();
                }}
                onUnsupported={() => setHidden(true)}
              />
            </>
          )}
        </Stack>
      </section>

      <RemovePasskeyDialog
        passkey={removing}
        name={removing ? passkeyName(removing, t) : ""}
        isLast={
          removing !== null &&
          !removing.removalPending &&
          live.length === 1 &&
          live[0].id === removing.id
        }
        onClose={(outcome) => closeRemove(outcome === "gone")}
        onChanged={() => void load()}
        onRemoved={() => {
          closeRemove(true);
          setNotice(
            t(
              "Passkey removed, and your other devices are signed out. You can also delete it from your device's password manager.",
            ),
          );
          void load();
        }}
      />
    </>
  );
}

function WorksUntil({
  passkeysWorkUntil,
}: {
  passkeysWorkUntil: string | null;
}) {
  const { t } = useTranslation();
  if (!passkeysWorkUntil || isPast(passkeysWorkUntil)) {
    return (
      <Text size="sm">
        {t(
          "Your passkeys are paused. Sign in with a code from your email to turn them back on.",
        )}
      </Text>
    );
  }
  return (
    <Text size="sm">
      {t(
        "Your passkeys work until {{date}}. Sign in with a code from your email before then to keep them working.",
        { date: passkeyDate(passkeysWorkUntil) },
      )}
    </Text>
  );
}
