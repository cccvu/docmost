import React, { useEffect, useState } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import { Group, MultiSelect, MultiSelectProps, Text } from "@mantine/core";
import { IGroup } from "@/features/group/types/group.types.ts";
import { useSearchSuggestionsQuery } from "@/features/search/queries/search-query.ts";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { IUser } from "@/features/user/types/user.types.ts";
import { IconGroupCircle } from "@/components/icons/icon-people-circle.tsx";
import { useTranslation } from "react-i18next";

interface MultiMemberSelectProps {
  value?: string[];
  onChange: (value: string[]) => void;
  /** CCC (wiki-v2 #797): offer groups too (default). `false` for a restricted page, which
      takes per-person grants only (INV-6: the server refuses every group grant there). */
  includeGroups?: boolean;
}

const renderMultiSelectOption: MultiSelectProps["renderOption"] = ({
  option,
}) => (
  <Group gap="sm" wrap="nowrap">
    {option["type"] === "user" && (
      <CustomAvatar
        avatarUrl={option["avatarUrl"]}
        size={20}
        name={option.label}
      />
    )}
    {option["type"] === "group" && <IconGroupCircle />}
    <div>
      <Text size="sm" lineClamp={1}>{option.label}</Text>
      {option["type"] === "user" && option["email"] && (
        <Text size="xs" c="dimmed" lineClamp={1}>{option["email"]}</Text>
      )}
    </div>
  </Group>
);

export function MultiMemberSelect({
  value,
  onChange,
  includeGroups = true,
}: MultiMemberSelectProps) {
  const { t } = useTranslation();
  const [searchValue, setSearchValue] = useState("");
  const [debouncedQuery] = useDebouncedValue(searchValue, 500);
  const { data: suggestion, isLoading } = useSearchSuggestionsQuery({
    query: debouncedQuery,
    includeUsers: true,
    includeGroups,
  });
  const [data, setData] = useState([]);

  useEffect(() => {
    if (suggestion) {
      // Extract user and group items
      const userItems = suggestion?.users.map((user: IUser) => ({
        value: `user-${user.id}`,
        label: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        type: "user",
      }));

      const groupItems = (includeGroups ? suggestion?.groups ?? [] : []).map((group: IGroup) => ({
        value: `group-${group.id}`,
        label: group.name,
        type: "group",
      }));

      // Create fresh data structure based on current search results
      const newData = [];
      
      if (userItems && userItems.length > 0) {
        newData.push({
          group: t("Select a user"),
          items: userItems,
        });
      }
      
      if (groupItems && groupItems.length > 0) {
        newData.push({
          group: t("Select a group"),
          items: groupItems,
        });
      }

      setData(newData);
    }
  }, [suggestion, t, includeGroups]);

  return (
    <MultiSelect
      data={data}
      value={value}
      renderOption={renderMultiSelectOption}
      hidePickedOptions
      maxDropdownHeight={300}
      label={t("Add members")}
      placeholder={
        includeGroups ? t("Search for users and groups") : t("Search for users")
      }
      searchable
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      filter={({ options }) => options}
      clearable
      variant="filled"
      onChange={onChange}
      maxValues={50}
    />
  );
}
