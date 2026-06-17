import { useEffect, useState } from 'react';
import {
  Modal, Form, Input, Switch, Select, Popconfirm, Tag, message, Alert, Tabs, Typography, Button, Upload,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, RobotOutlined, ApiOutlined,
  TeamOutlined, FilterOutlined, ThunderboltOutlined, WhatsAppOutlined, UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Agent, CustomApi, ContactFilter, CatalogTool, AgentAssets } from '../lib/types';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

const EMPTY_FILTER: ContactFilter = { mode: 'blacklist', contacts: [], groups: [] };
type AssetKind = 'menus' | 'reactions' | 'stickers' | 'labels' | 'files' | 'locations' | 'contacts';

/** All configured item labels across every asset kind — used to highlight them in the prompt. */
function allAssetLabels(a: AgentAssets): string[] {
  const kinds: AssetKind[] = ['menus', 'reactions', 'stickers', 'labels', 'files', 'locations', 'contacts'];
  const out: string[] = [];
  for (const k of kinds) for (const it of (a[k] ?? []) as Array<{ label?: string }>) if (it.label) out.push(it.label);
  return Array.from(new Set(out));
}

/** Coerce numbers and drop incomplete entries. */
function normalizeAssets(a: AgentAssets): AgentAssets {
  return {
    menus: (a.menus ?? []).filter(m => m.label && (m.options ?? []).length >= 2),
    reactions: (a.reactions ?? []).filter(r => r.label && r.emoji),
    stickers: (a.stickers ?? []).filter(s => s.label && s.url),
    labels: (a.labels ?? []).filter(l => l.label),
    files: (a.files ?? []).filter(f => f.label && f.url),
    locations: (a.locations ?? []).filter(l => l.label).map(l => ({
      ...l, latitude: Number(l.latitude) || 0, longitude: Number(l.longitude) || 0,
    })),
    contacts: (a.contacts ?? []).filter(c => c.label && c.fullName && c.phone),
  };
}

// ── Integrations (custom APIs) editor ────────────────────────────────────────

const KIND_OPTS = [
  { value: 'responding', label: 'Responde — o agente espera o resultado e usa na resposta' },
  { value: 'void', label: 'Ação — o agente executa e só confirma para o cliente' },
  { value: 'async', label: 'Demorada — o agente avisa "estou verificando" e responde quando o resultado chega' },
];

// ── Friendly fields table (generates JSON Schema + body template under the hood) ──

type FieldRow = { name: string; source: 'fixed' | 'agent'; type: 'text' | 'number' | 'bool'; value: string; description: string; required: boolean };

function jsonToFieldType(t?: string): FieldRow['type'] {
  return t === 'number' || t === 'integer' ? 'number' : t === 'boolean' ? 'bool' : 'text';
}

/** Build the JSON Schema (agent-decided fields) + body template from the friendly table. */
function buildFromFields(fields: FieldRow[], method: string): { schema: Record<string, unknown>; bodyTemplate: string } {
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  const parts: string[] = [];
  for (const f of fields) {
    const name = f.name.trim();
    if (!name) continue;
    const jt = f.type === 'number' ? 'number' : f.type === 'bool' ? 'boolean' : 'string';
    if (f.source === 'agent') {
      props[name] = f.description ? { type: jt, description: f.description } : { type: jt };
      if (f.required) required.push(name);
      parts.push(jt === 'string' ? `${JSON.stringify(name)}:"{${name}}"` : `${JSON.stringify(name)}:{${name}}`);
    } else {
      const lit = f.type === 'number' ? String(Number(f.value) || 0)
        : f.type === 'bool' ? (/^(true|sim|1|yes)$/i.test(f.value.trim()) ? 'true' : 'false')
        : JSON.stringify(f.value ?? '');
      parts.push(`${JSON.stringify(name)}:${lit}`);
    }
  }
  const schema = Object.keys(props).length
    ? { type: 'object', properties: props, ...(required.length ? { required } : {}) }
    : {};
  const noBody = method === 'GET' || method === 'HEAD';
  const bodyTemplate = (!noBody && parts.length) ? `{${parts.join(',')}}` : '';
  return { schema, bodyTemplate };
}

/** Reverse: turn a stored integration into table rows. Returns null if too advanced (nested JSON). */
function parseToFields(api: { schema?: Record<string, unknown>; bodyTemplate?: string }): FieldRow[] | null {
  const schema = (api.schema ?? {}) as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const fields: FieldRow[] = [];
  const seen = new Set<string>();

  const tpl = (api.bodyTemplate ?? '').trim();
  if (tpl) {
    let obj: Record<string, unknown>;
    try {
      // Replace {p} placeholders with safe markers so the template parses as JSON.
      const s = tpl.replace(/"\{(\w+)\}"/g, '"__PHS_$1__"').replace(/\{(\w+)\}/g, '"__PHN_$1__"');
      obj = JSON.parse(s) as Record<string, unknown>;
    } catch { return null; }
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && typeof v === 'object') return null; // nested → keep advanced mode
      const m = typeof v === 'string' ? /^__PH[SN]_(\w+)__$/.exec(v) : null;
      if (m) {
        const pname = m[1];
        const sp = props[pname] || props[k];
        fields.push({ name: k, source: 'agent', type: jsonToFieldType(sp?.type), value: '', description: sp?.description ?? '', required: required.has(pname) || required.has(k) });
        seen.add(pname); seen.add(k);
      } else {
        const type: FieldRow['type'] = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'text';
        fields.push({ name: k, source: 'fixed', type, value: typeof v === 'string' ? v : String(v), description: '', required: false });
        seen.add(k);
      }
    }
  }
  // Schema params not present in the body (e.g. values used only in the URL) → agent fields.
  for (const [k, sp] of Object.entries(props)) {
    if (seen.has(k)) continue;
    fields.push({ name: k, source: 'agent', type: jsonToFieldType(sp?.type), value: '', description: sp?.description ?? '', required: required.has(k) });
  }
  return fields;
}

/** Agent-decided fields derived from a schema only (used when the body is too advanced to parse). */
function fieldsFromSchema(schema?: Record<string, unknown>): FieldRow[] {
  const s = (schema ?? {}) as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties ?? {}).map(([k, sp]) => ({
    name: k, source: 'agent' as const, type: jsonToFieldType(sp?.type), value: '', description: sp?.description ?? '', required: required.has(k),
  }));
}

function FieldsEditor({ fields, onChange, method }: { fields: FieldRow[]; onChange: (f: FieldRow[]) => void; method: string }) {
  const set = (i: number, patch: Partial<FieldRow>) => onChange(fields.map((f, idx) => idx === i ? { ...f, ...patch } : f));
  const add = () => onChange([...fields, { name: '', source: 'agent', type: 'text', value: '', description: '', required: true }]);
  const remove = (i: number) => onChange(fields.filter((_, idx) => idx !== i));
  const isGet = method === 'GET' || method === 'HEAD';
  return (
    <div>
      {fields.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>Nenhum dado ainda. Adicione os campos que essa integração envia (ou use {'{campo}'} direto na URL).</Text>}
      {fields.map((f, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Input size="small" style={{ width: 130 }} placeholder="campo" value={f.name} onChange={e => set(i, { name: e.target.value })} />
          <Select size="small" style={{ width: 140 }} value={f.source}
            onChange={(v: 'fixed' | 'agent') => set(i, { source: v })}
            options={[{ value: 'agent', label: 'O agente decide' }, { value: 'fixed', label: 'Valor fixo' }]} />
          <Select size="small" style={{ width: 92 }} value={f.type}
            onChange={(v: FieldRow['type']) => set(i, { type: v })}
            options={[{ value: 'text', label: 'Texto' }, { value: 'number', label: 'Número' }, { value: 'bool', label: 'Sim/Não' }]} />
          {f.source === 'fixed'
            ? <Input size="small" style={{ flex: 1, minWidth: 130 }} placeholder="valor a enviar" value={f.value} onChange={e => set(i, { value: e.target.value })} />
            : <Input size="small" style={{ flex: 1, minWidth: 130 }} placeholder="o que o agente preenche" value={f.description} onChange={e => set(i, { description: e.target.value })} />}
          {f.source === 'agent' && (
            <span title="Obrigatório">obrig. <Switch size="small" checked={f.required} onChange={c => set(i, { required: c })} /></span>
          )}
          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => remove(i)} />
        </div>
      ))}
      <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={add}>Adicionar campo</Button>
      {isGet && fields.some(f => f.source === 'fixed') && (
        <div><Text type="warning" style={{ fontSize: 11 }}>Em chamadas GET não há corpo: valores fixos não são enviados — coloque-os direto na URL. Campos "o agente decide" entram na URL via {'{campo}'}.</Text></div>
      )}
    </div>
  );
}

function CustomApiEditor({ apis, onChange }: { apis: CustomApi[]; onChange: (apis: CustomApi[]) => void }) {
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [fields, setFields] = useState<FieldRow[]>([]);
  // The SCHEMA is always generated from the fields table. Only the BODY can optionally be
  // hand-written as a JSON template with {masks} (for shapes the table can't express).
  const [bodyManual, setBodyManual] = useState(false);
  const [form] = Form.useForm();

  const openNew = () => {
    form.resetFields();
    form.setFieldsValue({ method: 'GET', kind: 'responding', headers: [], bodyTemplate: '' });
    setFields([]); setBodyManual(false); setEditIdx(-1);
  };
  const openEdit = (i: number) => {
    const a = apis[i];
    form.setFieldsValue({
      name: a.name, description: a.description, url: a.url, method: a.method ?? 'GET',
      kind: a.kind ?? 'responding', waitingMessage: a.waitingMessage, headers: a.headers ?? [],
      bodyTemplate: a.bodyTemplate ?? '',
    });
    const parsed = parseToFields(a);
    if (parsed) { setFields(parsed); setBodyManual(false); }
    else { setFields(fieldsFromSchema(a.schema)); setBodyManual(true); } // body too advanced → keep it manual
    setEditIdx(i);
  };
  const remove = (i: number) => onChange(apis.filter((_, idx) => idx !== i));

  const setManual = (on: boolean) => {
    if (on) {
      // Seed the textarea with the auto-generated body so the user starts from something valid.
      const cur = String(form.getFieldValue('bodyTemplate') ?? '');
      if (!cur.trim()) form.setFieldsValue({ bodyTemplate: buildFromFields(fields, String(form.getFieldValue('method') ?? 'GET')).bodyTemplate });
    }
    setBodyManual(on);
  };

  const save = () => {
    form.validateFields().then(vals => {
      // Schema is ALWAYS generated from the fields table — the user never writes it.
      const built = buildFromFields(fields, String(vals.method));
      const bodyTemplate = bodyManual ? String(vals.bodyTemplate ?? '') : built.bodyTemplate;
      const api_: CustomApi = {
        name: vals.name, description: vals.description, url: vals.url, method: vals.method,
        kind: vals.kind, waitingMessage: vals.waitingMessage,
        headers: vals.headers ?? [], schema: built.schema, bodyTemplate,
      };
      if (editIdx === -1) onChange([...apis, api_]);
      else onChange(apis.map((a, i) => i === editIdx ? api_ : a));
      setEditIdx(null);
    });
  };

  const kind = Form.useWatch('kind', form);
  const method = Form.useWatch('method', form);
  const hasBody = method && method !== 'GET';

  return (
    <div>
      <Paragraph type="secondary" style={{ fontSize: 13 }}>
        Conecte o agente aos <b>seus</b> sistemas (pedidos, estoque, entregas…). É opcional e técnico —
        se você não tem um sistema para conectar, pode deixar em branco.
      </Paragraph>
      {apis.map((a, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
          <Tag color={a.kind === 'async' ? 'purple' : a.kind === 'void' ? 'orange' : 'blue'}>
            {a.kind === 'async' ? 'Demorada' : a.kind === 'void' ? 'Ação' : 'Responde'}
          </Tag>
          <Text strong style={{ fontSize: 13 }}>{a.name}</Text>
          <Text type="secondary" style={{ fontSize: 12, flex: 1 }}>{a.description}</Text>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(i)} />
          <Popconfirm title="Remover?" onConfirm={() => remove(i)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </div>
      ))}
      <Button type="dashed" icon={<PlusOutlined />} onClick={openNew} style={{ marginTop: 8 }}>
        Conectar um sistema
      </Button>

      <Modal
        title={editIdx === -1 ? 'Conectar um sistema' : 'Editar integração'}
        open={editIdx !== null}
        onOk={save}
        onCancel={() => setEditIdx(null)}
        width={560}
        okText="Salvar"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="name" label="Nome curto (sem espaços)" rules={[{ required: true }]}
            extra="Use esse nome nas instruções do agente. Ex.: consultar_pedido">
            <Input placeholder="consultar_pedido" />
          </Form.Item>
          <Form.Item name="description" label="O que essa integração faz" rules={[{ required: true }]}>
            <Input placeholder="Consulta o status de um pedido pelo número" />
          </Form.Item>
          <Form.Item name="kind" label="Como ela se comporta">
            <Select options={KIND_OPTS} />
          </Form.Item>
          {kind === 'async' && (
            <>
              <Form.Item name="waitingMessage" label="O que o agente está verificando (texto curto)"
                extra='Usado na mensagem "estou verificando ___…".'>
                <Input placeholder="o status do seu pedido" />
              </Form.Item>
              <Alert type="info" showIcon style={{ marginBottom: 16 }}
                message="Como o resultado volta pra conversa"
                description={<span style={{ fontSize: 12 }}>
                  Geramos um endereço de retorno único por chamada. Coloque a máscara <code>{'{url_de_retorno}'}</code> onde
                  o seu sistema espera o endereço — num campo do corpo (ex.: <code>{'"webhook":"{url_de_retorno}"'}</code>),
                  num cabeçalho, ou na URL. Também enviamos sempre no cabeçalho <code>X-Callback-Url</code>.<br />
                  Quando terminar, o seu sistema faz um <b>POST</b> nesse endereço com <code>{'{"result":"texto da resposta"}'}</code> — o agente então manda a mensagem final ao cliente.
                </span>} />
            </>
          )}
          <Form.Item name="url" label="Endereço (URL)" rules={[{ required: true }]}
            extra="Use {parametro} para inserir valores. Ex.: https://meusistema.com/pedidos/{numero}">
            <Input placeholder="https://meusistema.com/pedidos/{numero}" />
          </Form.Item>
          <Form.Item name="method" label="Tipo de chamada">
            <Select options={['GET', 'POST', 'PUT', 'DELETE'].map(m => ({ value: m, label: m }))} />
          </Form.Item>

          <Form.Item label="Dados que a integração envia"
            extra="Liste cada dado e quem preenche. Marque “O agente decide” para a IA preencher na hora, ou “Valor fixo” para um valor sempre igual. A plataforma monta tudo — você não escreve JSON.">
            <FieldsEditor fields={fields} onChange={setFields} method={method ?? 'GET'} />
          </Form.Item>

          {hasBody && (
            <Form.Item label={
              <span>
                Corpo manual (avançado)
                <Switch size="small" style={{ marginLeft: 8 }} checked={bodyManual} onChange={setManual} />
              </span>}
              extra={bodyManual
                ? <span>Escreva o corpo em JSON; use <code>{'{campo}'}</code> para os campos “o agente decide” da tabela acima. O schema continua sendo gerado pela tabela.</span>
                : 'Ative só se precisar de um corpo que a tabela não expressa (ex.: JSON aninhado).'}>
              {bodyManual
                ? <Form.Item name="bodyTemplate" noStyle>
                    <TextArea rows={4} style={{ fontFamily: 'monospace', fontSize: 12 }} placeholder='{"cliente":{"nome":"{nome}"},"itens":["{item}"]}' />
                  </Form.Item>
                : <Text type="secondary" style={{ fontSize: 12 }}>Corpo montado automaticamente pela tabela acima.</Text>}
            </Form.Item>
          )}

          <Form.List name="headers">
            {(fields, { add, remove }) => (
              <Form.Item label="Cabeçalhos / autenticação (headers)"
                extra="Necessário para APIs com chave. Ex.: Authorization = Bearer sk-... | x-api-key = sk-ant-... | anthropic-version = 2023-06-01 | content-type = application/json">
                {fields.map(({ key, name, ...rest }) => (
                  <div key={key} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <Form.Item {...rest} name={[name, 'key']} noStyle rules={[{ required: true, message: 'nome' }]}>
                      <Input placeholder="Authorization" style={{ flex: 1 }} />
                    </Form.Item>
                    <Form.Item {...rest} name={[name, 'value']} noStyle rules={[{ required: true, message: 'valor' }]}>
                      <Input placeholder="Bearer sk-..." style={{ flex: 2 }} />
                    </Form.Item>
                    <Button danger type="text" icon={<DeleteOutlined />} onClick={() => remove(name)} />
                  </div>
                ))}
                <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ key: '', value: '' })} block>
                  Adicionar cabeçalho
                </Button>
              </Form.Item>
            )}
          </Form.List>
        </Form>
      </Modal>
    </div>
  );
}

// ── Built-in actions (friendly switches with examples) ───────────────────────

// Upload a file to storage (MinIO) and return its public URL.
function FileUpload({ onUploaded }: { onUploaded: (url: string, name?: string, mimetype?: string) => void }) {
  const [loading, setLoading] = useState(false);
  return (
    <Upload
      showUploadList={false}
      beforeUpload={async (file) => {
        setLoading(true);
        try {
          const { url } = await api.uploadFile(file as File);
          onUploaded(url, (file as File).name, (file as File).type);
          message.success('Arquivo enviado!');
        } catch (e) { message.error((e as Error).message); }
        setLoading(false);
        return false; // we upload manually
      }}
    >
      <Button size="small" icon={<UploadOutlined />} loading={loading}>Upload</Button>
    </Upload>
  );
}

// Inline editor for an action's pre-configured content.
function AssetEditor({ kind, assets, onChange }: { kind: AssetKind; assets: AgentAssets; onChange: (a: AgentAssets) => void }) {
  const wrap = { marginTop: 10, paddingTop: 10, borderTop: '1px dashed #d9d9d9' } as const;

  // Menus: label + intro + options (rendered as a numbered text list to the client).
  if (kind === 'menus') {
    const menus = assets.menus ?? [];
    const upd = (items: typeof menus) => onChange({ ...assets, menus: items });
    const set = (i: number, f: string, v: unknown) => upd(menus.map((m, idx) => idx === i ? { ...m, [f]: v } : m));
    return (
      <div style={wrap}>
        {menus.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>Cadastre ao menos um menu para esta ação funcionar.</Text>}
        {menus.map((m, i) => (
          <div key={i} style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 8, marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <Input size="small" placeholder="Rótulo p/ citar no prompt (ex.: Horários)" value={m.label} onChange={e => set(i, 'label', e.target.value)} />
              <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => upd(menus.filter((_, idx) => idx !== i))} />
            </div>
            <Input size="small" placeholder="Texto de introdução (ex.: Para qual horário prefere?)" value={m.intro ?? ''} onChange={e => set(i, 'intro', e.target.value)} style={{ marginBottom: 6 }} />
            <Select mode="tags" size="small" style={{ width: '100%' }} value={m.options ?? []} onChange={(v: string[]) => set(i, 'options', v)}
              placeholder="Opções (digite cada uma e tecle Enter)" tokenSeparators={[',']} open={false} />
            <Text type="secondary" style={{ fontSize: 11 }}>O cliente recebe as opções numeradas e responde livremente; o agente entende a escolha.</Text>
          </div>
        ))}
        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => upd([...menus, { label: '', intro: '', options: [] }])}>Adicionar menu</Button>
      </div>
    );
  }

  // Reactions: label + emoji (so you can cite the label in the prompt).
  if (kind === 'reactions') {
    const reactions = assets.reactions ?? [];
    const upd = (items: typeof reactions) => onChange({ ...assets, reactions: items });
    const set = (i: number, f: string, v: string) => upd(reactions.map((r, idx) => idx === i ? { ...r, [f]: v } : r));
    return (
      <div style={wrap}>
        {reactions.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>Cadastre ao menos uma reação (rótulo + emoji) para esta ação funcionar.</Text>}
        {reactions.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <Input size="small" style={{ flex: 1 }} placeholder="Rótulo (ex.: Agradecimento)" value={r.label} onChange={e => set(i, 'label', e.target.value)} />
            <Input size="small" style={{ width: 70, textAlign: 'center' }} placeholder="👍" value={r.emoji} onChange={e => set(i, 'emoji', e.target.value)} />
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => upd(reactions.filter((_, idx) => idx !== i))} />
          </div>
        ))}
        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => upd([...reactions, { label: '', emoji: '' }])}>Adicionar reação</Button>
      </div>
    );
  }

  // Stickers: label + .webp file (upload to storage).
  if (kind === 'stickers') {
    const stickers = assets.stickers ?? [];
    const upd = (items: typeof stickers) => onChange({ ...assets, stickers: items });
    const set = (i: number, f: string, v: string) => upd(stickers.map((s, idx) => idx === i ? { ...s, [f]: v } : s));
    return (
      <div style={wrap}>
        {stickers.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>Cadastre ao menos uma figurinha para esta ação funcionar.</Text>}
        {stickers.map((s, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input size="small" style={{ flex: 1 }} placeholder="Rótulo (ex.: Comemoração)" value={s.label} onChange={e => set(i, 'label', e.target.value)} />
            <FileUpload onUploaded={(url) => set(i, 'url', url)} />
            <Input size="small" style={{ flex: 2 }} placeholder="URL do .webp (ou faça upload)" value={s.url} onChange={e => set(i, 'url', e.target.value)} />
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => upd(stickers.filter((_, idx) => idx !== i))} />
          </div>
        ))}
        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => upd([...stickers, { label: '', url: '' }])}>Adicionar figurinha</Button>
        <div><Text type="secondary" style={{ fontSize: 11 }}>Use arquivos no formato <b>.webp</b> (figurinha do WhatsApp).</Text></div>
      </div>
    );
  }

  // CRM labels: just a label name each (applied to the conversation in the painel).
  if (kind === 'labels') {
    const labels = assets.labels ?? [];
    const upd = (items: typeof labels) => onChange({ ...assets, labels: items });
    return (
      <div style={wrap}>
        <Text type="secondary" style={{ fontSize: 12 }}>Etiquetas que o agente pode aplicar à conversa (digite e tecle Enter):</Text>
        <Select mode="tags" style={{ width: '100%', marginTop: 6 }} value={labels.map(l => l.label)}
          onChange={(v: string[]) => upd(Array.from(new Set(v.map(s => s.trim()).filter(Boolean))).map(label => ({ label })))}
          placeholder="Lead quente, Comprou, Reclamação" tokenSeparators={[',']} open={false} />
      </div>
    );
  }

  // files / locations / contacts: generic field rows.
  const list = (assets[kind] ?? []) as Record<string, unknown>[];
  const update = (items: Record<string, unknown>[]) => onChange({ ...assets, [kind]: items });
  const setField = (i: number, field: string, val: string) => update(list.map((it, idx) => idx === i ? { ...it, [field]: val } : it));
  const setFields = (i: number, patch: Record<string, unknown>) => update(list.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  const add = () => update([...list, kind === 'files' ? { label: '', url: '', mediatype: 'document' }
    : kind === 'locations' ? { label: '', name: '', address: '', latitude: 0, longitude: 0 }
    : { label: '', fullName: '', phone: '' }]);
  const remove = (i: number) => update(list.filter((_, idx) => idx !== i));
  const inp = (i: number, field: string, placeholder: string, flex = 1) => (
    <Input size="small" style={{ flex }} placeholder={placeholder}
      value={String(list[i][field] ?? '')} onChange={e => setField(i, field, e.target.value)} />
  );

  return (
    <div style={wrap}>
      {list.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>Cadastre ao menos um item para esta ação funcionar.</Text>}
      {list.map((_, i) => (
        <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          {inp(i, 'label', 'Rótulo (ex.: Cardápio)', 1)}
          {kind === 'files' && <>
            <FileUpload onUploaded={(url, name, mt) => setFields(i, { url, fileName: name, mimetype: mt })} />
            {inp(i, 'url', 'URL do arquivo (ou faça upload)', 2)}
            <Select size="small" style={{ width: 110 }} value={String(list[i].mediatype ?? 'document')}
              onChange={v => setField(i, 'mediatype', v)}
              options={[{ value: 'document', label: 'Documento' }, { value: 'image', label: 'Imagem' }, { value: 'video', label: 'Vídeo' }]} />
          </>}
          {kind === 'locations' && <>
            {inp(i, 'name', 'Nome do local', 1)}
            {inp(i, 'address', 'Endereço', 2)}
            {inp(i, 'latitude', 'Latitude', 0.7)}
            {inp(i, 'longitude', 'Longitude', 0.7)}
          </>}
          {kind === 'contacts' && <>
            {inp(i, 'fullName', 'Nome do contato', 1)}
            {inp(i, 'phone', 'Telefone (+55 31 9…)', 1)}
          </>}
          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => remove(i)} />
        </div>
      ))}
      <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={add}>Adicionar</Button>
      {kind === 'locations' && (
        <div><Text type="secondary" style={{ fontSize: 11 }}>Dica: no Google Maps, clique no local — latitude e longitude aparecem (ex.: -19.93, -43.93).</Text></div>
      )}
    </div>
  );
}

function ActionsCatalog({ value, onChange, catalog, assets, onAssetsChange }: {
  value: string[]; onChange: (v: string[]) => void; catalog: CatalogTool[];
  assets: AgentAssets; onAssetsChange: (a: AgentAssets) => void;
}) {
  const toggle = (id: string, on: boolean) =>
    onChange(on ? Array.from(new Set([...value, id])) : value.filter(v => v !== id));

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="O que o agente pode fazer sozinho"
        description="Ligue as ações que você autoriza. O agente decide a hora certa de usar cada uma, conforme a conversa e suas instruções — você nunca precisa informar número, instância ou IDs. Tudo desligado = ele só conversa por texto."
      />
      {catalog.length === 0 && <Text type="secondary">Carregando ações…</Text>}
      {catalog.map(t => {
        const on = value.includes(t.id);
        return (
          <div key={t.id} style={{
            padding: '12px 14px', marginBottom: 8,
            border: `1px solid ${on ? '#0d9488' : '#f0f0f0'}`,
            background: on ? '#f0fdfa' : '#fff', borderRadius: 8,
          }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <Switch checked={on} onChange={c => toggle(t.id, c)} style={{ marginTop: 2 }} />
              <div style={{ flex: 1 }}>
                <Text strong style={{ fontSize: 14 }}>{t.label}</Text>
                <div><Text type="secondary" style={{ fontSize: 13 }}>{t.description}</Text></div>
                <div style={{ marginTop: 4 }}><Text style={{ fontSize: 12, color: '#0d9488' }}>💡 {t.example}</Text></div>
              </div>
            </div>
            {on && t.asset && <AssetEditor kind={t.asset} assets={assets} onChange={onAssetsChange} />}
          </div>
        );
      })}
    </div>
  );
}

// ── Prompt mask: highlight which configured tools are referenced in the prompt ─

function PromptToolMask({ prompt, toolNames }: { prompt: string; toolNames: string[] }) {
  if (toolNames.length === 0) return null;
  const referenced = toolNames.filter(n => n && prompt.toLowerCase().includes(n.toLowerCase()));
  return (
    <Alert
      type={referenced.length ? 'success' : 'warning'}
      showIcon
      style={{ marginTop: 8 }}
      message={referenced.length
        ? <span>Citadas nas instruções: {referenced.map(n => <Tag key={n} color="green">{n}</Tag>)}</span>
        : 'Dica: mencione as ações/integrações nas instruções (ex.: "se pedirem o endereço, envie a localização") para o agente saber quando usá-las.'}
    />
  );
}

// ── Agent Modal ──────────────────────────────────────────────────────────────

export default function AgentModal({ agent, open, onClose, catalog, connectionId, connectionName }: {
  agent: Agent | null;
  open: boolean;
  onClose: () => void;
  catalog: CatalogTool[];
  connectionId?: string;
  connectionName?: string;
}) {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [customApis, setCustomApis] = useState<CustomApi[]>([]);
  const [builtinTools, setBuiltinTools] = useState<string[]>([]);
  const [assets, setAssets] = useState<AgentAssets>({});
  const [filter, setFilter] = useState<ContactFilter>(EMPTY_FILTER);
  const [prompt, setPrompt] = useState('');
  const isEdit = !!agent;

  useEffect(() => {
    if (!open) return;
    if (agent) {
      form.setFieldsValue({
        name: agent.name,
        assistantName: agent.assistantName,
        respondToMentions: agent.groupConfig?.respondToMentions ?? true,
        respondToReplies: agent.groupConfig?.respondToReplies ?? true,
        respondToAll: agent.groupConfig?.respondToAll ?? false,
      });
      setBuiltinTools(agent.builtinTools ?? []);
      setAssets(agent.assets ?? {});
      setFilter(agent.contactFilter ?? EMPTY_FILTER);
      api.getAgent(agent._id).then(full => {
        form.setFieldsValue({ systemPrompt: full.systemPrompt });
        setPrompt(full.systemPrompt ?? '');
        setCustomApis(full.customApis ?? []);
        setBuiltinTools(full.builtinTools ?? []);
        setAssets(full.assets ?? {});
        setFilter(full.contactFilter ?? EMPTY_FILTER);
      }).catch(() => { /* ignore */ });
    } else {
      form.resetFields();
      form.setFieldsValue({ respondToMentions: true, respondToReplies: true, respondToAll: false });
      setCustomApis([]); setBuiltinTools([]); setAssets({}); setFilter(EMPTY_FILTER); setPrompt('');
    }
  }, [open, agent, form]);

  function buildPayload(vals: Record<string, unknown>) {
    return {
      name: vals.name as string,
      assistantName: vals.assistantName as string,
      systemPrompt: vals.systemPrompt as string,
      tools: [], // messaging is handled by the platform; no raw namespaces exposed to the LLM
      builtinTools,
      assets: normalizeAssets(assets),
      customApis,
      contactFilter: filter,
      connectionId,
      groupConfig: {
        respondToMentions: vals.respondToMentions as boolean,
        respondToReplies: vals.respondToReplies as boolean,
        respondToAll: vals.respondToAll as boolean,
      },
    };
  }

  const create = useMutation({
    mutationFn: (vals: Record<string, unknown>) => api.createAgent(buildPayload(vals)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['connections'] });
      message.success('Agente criado!');
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });
  const update = useMutation({
    mutationFn: (vals: Record<string, unknown>) => api.updateAgent(agent!._id, buildPayload(vals)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents'] }); message.success('Agente atualizado!'); onClose(); },
    onError: (e: Error) => message.error(e.message),
  });

  const submit = () => form.validateFields().then(vals => {
    if (isEdit) update.mutate(vals as Record<string, unknown>);
    else create.mutate(vals as Record<string, unknown>);
  });

  const toolNames = Array.from(new Set([
    ...customApis.map(a => a.name),
    ...catalog.filter(c => builtinTools.includes(c.id)).map(c => c.label),
    ...allAssetLabels(assets), // menu/reação/figurinha/etiqueta/arquivo… labels you cite in the prompt
  ].filter(Boolean)));

  return (
    <Modal
      title={isEdit ? `Editar agente — ${agent.name}` : 'Novo agente'}
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={create.isPending || update.isPending}
      okText={isEdit ? 'Salvar' : 'Criar agente'}
      width={680}
      destroyOnClose
    >
      {connectionName && (
        <Alert
          type="success" showIcon icon={<WhatsAppOutlined />}
          style={{ marginBottom: 12 }}
          message={<span>Este agente vai atender no WhatsApp <b>{connectionName}</b></span>}
        />
      )}
      <Form form={form} layout="vertical">
        <Tabs defaultActiveKey="basic" items={[
          {
            key: 'basic',
            label: <span><RobotOutlined /> Identidade</span>,
            children: (
              <>
                <Form.Item name="name" label="Nome do agente (só para você organizar)" rules={[{ required: true }]}>
                  <Input placeholder="Atendimento Vendas" />
                </Form.Item>
                <Form.Item name="assistantName" label="Como o agente se apresenta ao cliente">
                  <Input placeholder="Sofia" />
                </Form.Item>
                <Form.Item name="systemPrompt" label="Instruções do agente" rules={[{ required: true }]}
                  extra="Descreva a personalidade, o que ele deve fazer e quando usar cada ação.">
                  <TextArea rows={8} placeholder="Você é a Sofia, atendente da empresa. Seja simpática e objetiva. Se o cliente pedir o endereço, envie a localização…" onChange={e => setPrompt(e.target.value)} />
                </Form.Item>
                <PromptToolMask prompt={prompt} toolNames={toolNames} />
              </>
            ),
          },
          {
            key: 'actions',
            label: <span><ThunderboltOutlined /> Ações</span>,
            children: <ActionsCatalog value={builtinTools} onChange={setBuiltinTools} catalog={catalog} assets={assets} onAssetsChange={setAssets} />,
          },
          {
            key: 'integrations',
            label: <span><ApiOutlined /> Integrações</span>,
            children: <CustomApiEditor apis={customApis} onChange={setCustomApis} />,
          },
          {
            key: 'filter',
            label: <span><FilterOutlined /> Quem ele atende</span>,
            children: (
              <>
                <Paragraph type="secondary" style={{ fontSize: 13 }}>
                  Por padrão o agente responde a todos neste WhatsApp. Restrinja apenas se você tiver
                  <b> mais de um agente no mesmo número</b> (ex.: um só para o grupo dos entregadores).
                </Paragraph>
                <Form.Item label="Modo">
                  <Select
                    value={filter.mode}
                    onChange={mode => setFilter({ ...filter, mode })}
                    options={[
                      { value: 'blacklist', label: 'Responder a todos, EXCETO os bloqueados' },
                      { value: 'whitelist', label: 'Responder SOMENTE aos permitidos' },
                    ]}
                  />
                </Form.Item>
                <Form.Item label={filter.mode === 'whitelist' ? 'Números permitidos' : 'Números bloqueados'}
                  extra="Digite o número com DDI/DDD (ex.: 5511999998888) e tecle Enter.">
                  <Select mode="tags" value={filter.contacts} onChange={contacts => setFilter({ ...filter, contacts })}
                    placeholder="5511999998888" tokenSeparators={[',', ' ']} open={false} />
                </Form.Item>
                <Form.Item label={filter.mode === 'whitelist' ? 'Grupos permitidos' : 'Grupos bloqueados'}
                  extra="Cole o ID do grupo (termina com @g.us) e tecle Enter.">
                  <Select mode="tags" value={filter.groups} onChange={groups => setFilter({ ...filter, groups })}
                    placeholder="1203...@g.us" tokenSeparators={[',', ' ']} open={false} />
                </Form.Item>
              </>
            ),
          },
          {
            key: 'groups',
            label: <span><TeamOutlined /> Grupos</span>,
            children: (
              <>
                <Alert type="info" showIcon message="Em grupos, o agente só responde se uma destas condições for atendida." style={{ marginBottom: 16 }} />
                <Form.Item name="respondToMentions" label="Responder quando mencionado (@)" valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Form.Item name="respondToReplies" label="Responder quando respondem a uma mensagem dele" valuePropName="checked">
                  <Switch />
                </Form.Item>
                <Form.Item name="respondToAll" label="Responder a todas as mensagens do grupo" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </>
            ),
          },
        ]} />
      </Form>
    </Modal>
  );
}
