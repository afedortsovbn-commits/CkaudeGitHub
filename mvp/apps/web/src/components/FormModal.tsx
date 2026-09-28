import {
  Button,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  Select,
  Stack,
  Switch,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { t } from '../lib/i18n';

export type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'switch' | 'password';

export interface FormField {
  key: string;
  label: string;
  type?: FieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  description?: string;
  /** Поле показывается только при создании. */
  createOnly?: boolean;
  placeholder?: string;
  /** Показывать поле в зависимости от текущих значений формы (например, от типа канала). */
  show?(values: Record<string, unknown>): boolean;
}

interface Props {
  opened: boolean;
  title: string;
  fields: FormField[];
  initial?: Record<string, unknown>;
  isCreate: boolean;
  loading?: boolean;
  onClose(): void;
  onSubmit(values: Record<string, unknown>): void;
}

/** Универсальная форма: значения пустых необязательных полей отправляются как null. */
export function FormModal({ opened, title, fields, initial, isCreate, loading, onClose, onSubmit }: Props) {
  const [v, setV] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (opened) setV(initial ?? {});
  }, [opened, initial]);
  const set = (k: string, val: unknown) => setV((s) => ({ ...s, [k]: val }));
  const visible = fields.filter((f) => (isCreate || !f.createOnly) && (!f.show || f.show(v)));

  const submit = () => {
    const out: Record<string, unknown> = {};
    for (const f of visible) {
      let val = v[f.key];
      if (f.type === 'switch') val = !!val;
      else if (f.type === 'multiselect') val = (val as string[] | undefined) ?? [];
      else if (val === '' || val === undefined) val = f.required ? val : null;
      if (val === undefined || (isCreate && val === null && !f.required)) continue;
      out[f.key] = val;
    }
    onSubmit(out);
  };

  return (
    <Modal opened={opened} onClose={onClose} title={title} size="lg">
      <Stack>
        {visible.map((f) => {
          const common = {
            key: f.key,
            label: f.label,
            required: f.required,
            description: f.description,
            placeholder: f.placeholder,
          };
          switch (f.type) {
            case 'number':
              return (
                <NumberInput
                  {...common}
                  value={(v[f.key] as number | undefined) ?? ''}
                  onChange={(x) => set(f.key, x === '' ? null : Number(x))}
                />
              );
            case 'select':
              return (
                <Select
                  {...common}
                  data={f.options ?? []}
                  value={(v[f.key] as string | null) ?? null}
                  onChange={(x) => set(f.key, x)}
                  searchable
                  clearable={!f.required}
                />
              );
            case 'multiselect':
              return (
                <MultiSelect
                  {...common}
                  data={f.options ?? []}
                  value={(v[f.key] as string[] | undefined) ?? []}
                  onChange={(x) => set(f.key, x)}
                  searchable
                />
              );
            case 'switch':
              return (
                <Switch
                  key={f.key}
                  label={f.label}
                  checked={!!v[f.key]}
                  onChange={(e) => set(f.key, e.currentTarget.checked)}
                />
              );
            case 'textarea':
              return (
                <Textarea
                  {...common}
                  autosize
                  minRows={3}
                  value={(v[f.key] as string) ?? ''}
                  onChange={(e) => set(f.key, e.currentTarget.value)}
                />
              );
            default:
              return (
                <TextInput
                  {...common}
                  type={f.type === 'password' ? 'password' : 'text'}
                  value={(v[f.key] as string) ?? ''}
                  onChange={(e) => set(f.key, e.currentTarget.value)}
                />
              );
          }
        })}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button onClick={submit} loading={loading}>
            {isCreate ? t.create : t.save}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
