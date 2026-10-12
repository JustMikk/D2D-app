"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { onSubmitWith } from "@/components/ui/form";
import { useToast } from "@/components/ui/Toast";
import type { SettingKey, SettingsMap } from "@/lib/domain/settings";
import { SETTING_GROUPS, US_TIME_ZONES, type SettingField } from "@/lib/ui/settingsMeta";
import { saveSettingsAction } from "./actions";

type Values = Record<string, string | boolean>;

function toText(v: SettingsMap[SettingKey]): string {
  return v === null ? "" : String(v);
}

/** Convert what the form holds back to the setting's own type. */
function fromText(field: SettingField, raw: string | boolean): unknown {
  if (field.kind === "bool") return Boolean(raw);
  const text = String(raw).trim();
  if (field.kind === "url") return text === "" ? null : text;
  if (field.kind === "int" || field.kind === "number") return text === "" ? Number.NaN : Number(text);
  return text;
}

export function SettingsForm({ settings }: { settings: SettingsMap }) {
  const initial: Values = Object.fromEntries(SETTING_GROUPS.flatMap((g) => g.fields).map((f) => [f.key, toText(settings[f.key])]));
  const [values, setValues] = useState<Values>(initial);
  const [saved, setSaved] = useState<Values>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();

  const changed = SETTING_GROUPS.flatMap((g) => g.fields).filter((f) => values[f.key] !== saved[f.key]);

  function save() {
    setErrors({});
    setFormError(null);
    const patch = Object.fromEntries(changed.map((f) => [f.key, fromText(f, values[f.key]!)]));
    start(async () => {
      const result = await saveSettingsAction(patch);
      if (result.ok) {
        setSaved(values);
        toast.show("Settings saved");
      } else {
        setErrors(result.fields);
        setFormError(result.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmitWith(save)} className="flex flex-col gap-8">
      {SETTING_GROUPS.map((group) => (
        <section key={group.id} className="flex flex-col gap-4" aria-labelledby={`settings-${group.id}`}>
          <div className="flex flex-col gap-1">
            <h2 id={`settings-${group.id}`} className="text-title-m">
              {group.title}
            </h2>
            <p className="text-body text-ink-2">{group.description}</p>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-md border border-line bg-surface p-5">
            {group.fields.map((f) => (
              <Field key={f.key} label={f.unit ? `${f.label} (${f.unit})` : f.label} helper={f.help} error={errors[f.key]}>
                {(p) => {
                  const value = String(values[f.key] ?? "");
                  const set = (v: string) => setValues((s) => ({ ...s, [f.key]: v }));
                  if (f.kind === "select")
                    return (
                      <Select {...p} value={value} onChange={(e) => set(e.target.value)}>
                        {f.options!.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    );
                  if (f.kind === "timezone")
                    return (
                      <Select {...p} value={value} onChange={(e) => set(e.target.value)}>
                        {[...new Set([...US_TIME_ZONES, value])].map((z) => (
                          <option key={z} value={z}>
                            {z}
                          </option>
                        ))}
                      </Select>
                    );
                  return (
                    <Input
                      {...p}
                      value={value}
                      onChange={(e) => set(e.target.value)}
                      type={f.kind === "time" ? "time" : f.kind === "url" ? "url" : "text"}
                      inputMode={f.kind === "int" ? "numeric" : f.kind === "number" ? "decimal" : undefined}
                      placeholder={f.kind === "url" ? "https://n8n.example.com/webhook/canvass" : undefined}
                    />
                  );
                }}
              </Field>
            ))}
          </div>
        </section>
      ))}

      <div className="sticky bottom-0 -mx-[var(--gutter-mgr)] flex items-center gap-4 border-t border-line bg-bg px-[var(--gutter-mgr)] py-3">
        <Button type="submit" disabled={pending || changed.length === 0}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        {changed.length > 0 && !pending && <span className="text-body text-ink-2">{changed.length} unsaved {changed.length === 1 ? "change" : "changes"}</span>}
        {formError && (
          <span role="alert" className="text-body text-danger">
            {formError}
          </span>
        )}
      </div>
    </form>
  );
}
