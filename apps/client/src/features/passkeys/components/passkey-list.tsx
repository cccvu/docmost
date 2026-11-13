import { useId } from "react";
import {
  Badge,
  Button,
  Group,
  Table,
  Text,
  VisuallyHidden,
} from "@mantine/core";
import { IconKey } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { PasskeyView } from "../types.ts";
import { passkeyDate, passkeyName } from "./passkey-format.ts";

// wiki-v2 #818 — NOT upstream Docmost code. Profile → Passkeys: the signed-in person's passkeys as a captioned table
// (provider, Synced / This device only, added, last used). A row whose removal stopped half-way (the passkey no
// longer works, but the other-device sign-out did not finish) says so and offers "Try again".

export interface PasskeyListProps {
  passkeys: PasskeyView[];
  /** Start removing this passkey (or resume a removal that did not finish). Opens the confirm dialog. */
  onRemove: (passkey: PasskeyView) => void;
}

export function PasskeyList({ passkeys, onRemove }: PasskeyListProps) {
  const { t } = useTranslation();

  if (passkeys.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t("You haven't added a passkey yet.")}
      </Text>
    );
  }

  return (
    <Table verticalSpacing="sm" captionSide="top">
      <Table.Caption>{t("Your passkeys")}</Table.Caption>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t("Passkey")}</Table.Th>
          <Table.Th>{t("Added")}</Table.Th>
          <Table.Th>{t("Last used")}</Table.Th>
          <Table.Th>
            <VisuallyHidden>{t("Action")}</VisuallyHidden>
          </Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {passkeys.map((passkey) => (
          <PasskeyRow key={passkey.id} passkey={passkey} onRemove={onRemove} />
        ))}
      </Table.Tbody>
    </Table>
  );
}

function PasskeyRow({
  passkey,
  onRemove,
}: {
  passkey: PasskeyView;
  onRemove: (passkey: PasskeyView) => void;
}) {
  const { t } = useTranslation();
  const name = passkeyName(passkey, t);
  const addedId = useId();
  const pendingId = useId();

  return (
    <Table.Tr>
      <Table.Td>
        <Group gap="xs" wrap="nowrap">
          <IconKey size={18} stroke={1.5} aria-hidden="true" />
          <div>
            <Text size="sm">{name}</Text>
            <Badge size="xs" variant="light" color="gray">
              {passkey.backupEligible ? t("Synced") : t("This device only")}
            </Badge>
          </div>
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="sm" id={addedId}>
          {passkeyDate(passkey.createdAt)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">
          {passkey.lastUsedAt ? passkeyDate(passkey.lastUsedAt) : t("Never")}
        </Text>
      </Table.Td>
      <Table.Td>
        {passkey.removalPending ? (
          <Group gap={4} wrap="nowrap">
            <Text size="xs" c="red" id={pendingId}>
              {t("Removal not finished")}
            </Text>
            <Text size="xs" c="dimmed" aria-hidden="true">
              ·
            </Text>
            <Button
              variant="subtle"
              size="compact-xs"
              aria-label={t("Try again to remove passkey {{name}}", { name })}
              aria-describedby={`${pendingId} ${addedId}`}
              onClick={() => onRemove(passkey)}
            >
              {t("Try again")}
            </Button>
          </Group>
        ) : (
          <Button
            variant="outline"
            color="red"
            size="xs"
            aria-label={t("Remove passkey {{name}}", { name })}
            aria-describedby={addedId}
            onClick={() => onRemove(passkey)}
          >
            {t("Remove")}
          </Button>
        )}
      </Table.Td>
    </Table.Tr>
  );
}
