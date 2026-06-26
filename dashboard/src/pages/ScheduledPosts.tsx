import { useState } from 'react';
import {
  Typography, Button, Card, Badge, Space, Modal, Form, Input, Select,
  Checkbox, Popconfirm, Tag, message, Divider, Alert, Radio,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, CalendarOutlined, PauseCircleOutlined,
  PlayCircleOutlined, EditOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { ScheduledPost, PipelineStep, PostTarget, Agent } from '../lib/types';
import dayjs from 'dayjs';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const DEFAULT_AI_SYS = 'Você é um criador de conteúdo para WhatsApp. Escreva uma mensagem curta, natural e pronta para enviar (sem títulos, sem aspas). Use emojis com moderação.';

function formatSchedule(s: ScheduledPost['schedule']) {
  const dayStr = s.days.map(d => DAYS[d]).join(', ');
  return `${dayStr} às ${s.time}`;
}

/** Friendly one-line summary of what a post sends (from its pipeline). */
function contentSummary(p: ScheduledPost): string {
  const compose = p.pipeline.find(s => s.type === 'compose');
  const hasImage = p.pipeline.some(s => s.type === 'image_gen');
  const isFixed = compose && typeof compose.config.static === 'string' && compose.config.static.trim();
  const base = isFixed ? 'Texto fixo' : compose ? 'Gerado por IA' : 'Conteúdo';
  return hasImage ? `${base} + imagem` : base;
}

// ── Friendly destinations (contact phone / group from a list / status) ───────

function TargetEditor({ targets, onChange, groups }: {
  targets: PostTarget[]; onChange: (t: PostTarget[]) => void; groups: { id: string; subject: string }[];
}) {
  const add = () => onChange([...targets, { type: 'contact', jid: '' }]);
  const remove = (i: number) => onChange(targets.filter((_, idx) => idx !== i));
  const set = (i: number, patch: Partial<PostTarget>) => onChange(targets.map((t, idx) => idx === i ? { ...t, ...patch } : t));

  return (
    <div>
      {targets.map((t, i) => (
        <Space key={i} style={{ display: 'flex', marginBottom: 8 }} align="baseline" wrap>
          <Select value={t.type} style={{ width: 110 }}
            onChange={v => set(i, { type: v, jid: '' })}
            options={[
              { value: 'contact', label: 'Contato' },
              { value: 'group', label: 'Grupo' },
              { value: 'status', label: 'Status' },
            ]} />
          {t.type === 'contact' && (
            <Input style={{ width: 240 }} placeholder="Telefone (ex.: 5531999998888)"
              value={t.jid.replace(/@.*/, '').replace(/\D/g, '')}
              onChange={e => {
                const d = e.target.value.replace(/\D/g, '');
                set(i, { jid: d ? `${d}@s.whatsapp.net` : '' });
              }} />
          )}
          {t.type === 'group' && (
            <Select showSearch optionFilterProp="label" style={{ width: 280 }}
              placeholder={groups.length ? 'Escolha o grupo' : 'Conecte o WhatsApp para listar grupos'}
              value={t.jid || undefined} onChange={v => set(i, { jid: v })}
              options={groups.map(g => ({ value: g.id, label: g.subject }))} />
          )}
          {t.type === 'status' && <Text type="secondary" style={{ fontSize: 12 }}>Publica no seu Status do WhatsApp</Text>}
          <Button icon={<DeleteOutlined />} size="small" danger onClick={() => remove(i)} />
        </Space>
      ))}
      <Button type="dashed" icon={<PlusOutlined />} onClick={add}>Adicionar destino</Button>
    </div>
  );
}

// ── Post Form Modal (friendly: fixed text or AI, optional image, simple targets) ──

function PostModal({ post, agentId, agents, open, onClose }: {
  post: ScheduledPost | null; agentId: string; agents: Agent[]; open: boolean; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [contentMode, setContentMode] = useState<'fixed' | 'ai'>('fixed');
  const [fixedText, setFixedText] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [withImage, setWithImage] = useState(false);
  const [imagePrompt, setImagePrompt] = useState('');
  const [targets, setTargets] = useState<PostTarget[]>([]);
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const isEdit = !!post;

  // Groups for the agent's WhatsApp, so destinations can be picked by name.
  const connId = agents.find(a => a._id === agentId)?.connectionId;
  const { data: groups = [] } = useQuery({
    queryKey: ['conn-groups', connId], queryFn: () => api.getConnectionGroups(connId!), enabled: open && !!connId,
  });

  const resetForm = () => {
    form.setFieldsValue({
      time: post?.schedule.time ?? '09:00',
      timezone: post?.schedule.timezone ?? 'America/Sao_Paulo',
    });
    setSelectedDays(post?.schedule.days ?? [1, 2, 3, 4, 5]);
    setTargets(post?.targets ?? []);
    const compose = post?.pipeline.find(s => s.type === 'compose');
    const img = post?.pipeline.find(s => s.type === 'image_gen');
    const staticT = compose && typeof compose.config.static === 'string' ? compose.config.static : '';
    if (staticT) { setContentMode('fixed'); setFixedText(staticT); setAiPrompt(''); }
    else if (compose) { setContentMode('ai'); setAiPrompt(String(compose.config.prompt ?? '')); setFixedText(''); }
    else { setContentMode('fixed'); setFixedText(''); setAiPrompt(''); }
    setWithImage(!!img);
    setImagePrompt(img ? String(img.config.prompt ?? '') : '');
  };

  const buildPipeline = (): PipelineStep[] => {
    const steps: PipelineStep[] = [];
    if (contentMode === 'fixed') steps.push({ type: 'compose', config: { static: fixedText.trim() } });
    else steps.push({ type: 'compose', config: { prompt: aiPrompt.trim(), systemPrompt: DEFAULT_AI_SYS } });
    if (withImage) steps.push({ type: 'image_gen', config: { prompt: (imagePrompt.trim() || aiPrompt.trim() || fixedText.trim()) } });
    return steps;
  };

  const save = useMutation({
    mutationFn: (vals: Record<string, unknown>) => {
      const payload = {
        agentId,
        schedule: { days: selectedDays, time: vals.time as string, timezone: vals.timezone as string },
        pipeline: buildPipeline(),
        targets,
      };
      return isEdit ? api.updateScheduledPost(post!._id, payload) : api.createScheduledPost(payload);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduled_posts'] }); message.success(isEdit ? 'Postagem atualizada!' : 'Postagem agendada!'); onClose(); },
    onError: (e: Error) => message.error(e.message),
  });

  const submit = () => {
    if (contentMode === 'fixed' && !fixedText.trim()) { message.warning('Escreva a mensagem a enviar.'); return; }
    if (contentMode === 'ai' && !aiPrompt.trim()) { message.warning('Descreva o que a IA deve escrever.'); return; }
    if (selectedDays.length === 0) { message.warning('Escolha pelo menos um dia.'); return; }
    if (targets.length === 0) { message.warning('Adicione pelo menos um destino.'); return; }
    form.validateFields().then(vals => save.mutate(vals as Record<string, unknown>));
  };

  return (
    <Modal
      title={isEdit ? 'Editar postagem' : 'Nova postagem agendada'}
      open={open}
      onCancel={onClose}
      onOk={submit}
      afterOpenChange={o => { if (o) resetForm(); }}
      confirmLoading={save.isPending}
      okText={isEdit ? 'Salvar' : 'Criar'}
      width={640}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Divider orientation="left">O que enviar</Divider>
        <Radio.Group value={contentMode} onChange={e => setContentMode(e.target.value)} style={{ marginBottom: 12 }}>
          <Radio.Button value="fixed">Texto fixo</Radio.Button>
          <Radio.Button value="ai">Gerar com IA</Radio.Button>
        </Radio.Group>

        {contentMode === 'fixed' ? (
          <Form.Item label="Mensagem" style={{ marginBottom: 12 }}>
            <TextArea rows={4} value={fixedText} onChange={e => setFixedText(e.target.value)}
              placeholder="Bom dia! ☀️ Hoje temos promoção de…" />
          </Form.Item>
        ) : (
          <Form.Item label="O que a IA deve escrever?" style={{ marginBottom: 12 }}
            extra="A IA escreve uma mensagem nova a cada envio, seguindo esta orientação.">
            <TextArea rows={3} value={aiPrompt} onChange={e => setAiPrompt(e.target.value)}
              placeholder="Uma mensagem de bom dia motivacional e curta para os clientes." />
          </Form.Item>
        )}

        <Checkbox checked={withImage} onChange={e => setWithImage(e.target.checked)} style={{ marginBottom: withImage ? 8 : 0 }}>
          Incluir uma imagem gerada por IA
        </Checkbox>
        {withImage && (
          <Form.Item style={{ marginTop: 8, marginBottom: 0 }}
            extra="Descreva a imagem. Se deixar vazio, usamos o texto acima como base.">
            <Input value={imagePrompt} onChange={e => setImagePrompt(e.target.value)}
              placeholder="Ex.: xícara de café ao nascer do sol, estilo aconchegante" />
          </Form.Item>
        )}

        <Divider orientation="left">Quando enviar</Divider>
        <Form.Item label="Dias da semana">
          <Checkbox.Group
            value={selectedDays}
            onChange={vals => setSelectedDays(vals as number[])}
            options={DAYS.map((d, i) => ({ label: d, value: i }))}
          />
        </Form.Item>
        <Space>
          <Form.Item name="time" label="Horário (HH:MM)" rules={[{ required: true, pattern: /^\d{2}:\d{2}$/, message: 'Ex: 09:00' }]}>
            <Input placeholder="09:00" style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="timezone" label="Fuso horário">
            <Select style={{ width: 220 }} options={[
              { value: 'America/Sao_Paulo', label: 'Brasil (BRT)' },
              { value: 'America/Manaus', label: 'Manaus (AMT)' },
              { value: 'America/Fortaleza', label: 'Fortaleza (BRT)' },
              { value: 'America/Belem', label: 'Belém (BRT)' },
              { value: 'UTC', label: 'UTC' },
            ]} />
          </Form.Item>
        </Space>

        <Divider orientation="left">Para quem</Divider>
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          Contato: digite o telefone. Grupo: escolha na lista. Status: publica no seu Status do WhatsApp.
        </Paragraph>
        <TargetEditor targets={targets} onChange={setTargets} groups={groups} />
      </Form>
    </Modal>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function ScheduledPosts() {
  const qc = useQueryClient();
  const [agentFilter, setAgentFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editPost, setEditPost] = useState<ScheduledPost | null>(null);

  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: api.getAgents });
  const { data: posts = [], isLoading } = useQuery({
    queryKey: ['scheduled_posts', agentFilter],
    queryFn: () => api.getScheduledPosts(agentFilter || undefined),
  });

  const toggle = useMutation({
    mutationFn: (id: string) => api.toggleScheduledPost(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduled_posts'] }); },
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteScheduledPost(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduled_posts'] }); message.success('Postagem removida.'); },
    onError: (e: Error) => message.error(e.message),
  });

  const openCreate = () => { setEditPost(null); setModalOpen(true); };
  const openEdit = (p: ScheduledPost) => { setEditPost(p); setModalOpen(true); };

  const agentName = (id: string) => agents.find(a => a._id === id)?.name ?? id;
  const currentAgentId = agentFilter || (agents[0]?._id ?? '');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 8, flexWrap: 'wrap' }}>
        <Title level={3} style={{ margin: 0 }}><CalendarOutlined /> Postagens agendadas</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={agents.length === 0}>
          Nova postagem
        </Button>
      </div>

      <Space style={{ marginBottom: 16 }}>
        <Select
          placeholder="Filtrar por agente"
          value={agentFilter || undefined}
          onChange={v => setAgentFilter(v ?? '')}
          allowClear
          style={{ width: 220 }}
          options={agents.map(a => ({ value: a._id, label: a.name }))}
        />
      </Space>

      {agents.length === 0 && (
        <Alert type="info" showIcon message="Crie um agente primeiro para agendar postagens." />
      )}

      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {!isLoading && posts.length === 0 && agents.length > 0 && (
          <Card>
            <div style={{ textAlign: 'center', padding: 32 }}>
              <CalendarOutlined style={{ fontSize: 40, color: '#d9d9d9', marginBottom: 12 }} />
              <Title level={5} type="secondary">Nenhuma postagem agendada</Title>
              <Paragraph type="secondary">Crie postagens recorrentes com pipelines de conteúdo automático.</Paragraph>
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Criar postagem</Button>
            </div>
          </Card>
        )}

        {posts.map(p => (
          <Card key={p._id} styles={{ body: { padding: '14px 20px' } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge status={p.status === 'active' ? 'success' : 'default'} text={<Text strong>{formatSchedule(p.schedule)}</Text>} />
                  <Tag color="blue">{agentName(p.agentId)}</Tag>
                  <Tag>{p.targets.length} destino{p.targets.length !== 1 ? 's' : ''}</Tag>
                </div>
                <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Tag style={{ fontSize: 11 }}>{contentSummary(p)}</Tag>
                </div>
                {p.lastRun && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    Última execução: {dayjs(p.lastRun).format('DD/MM/YY HH:mm')}
                  </Text>
                )}
              </div>
              <Space wrap>
                <Button
                  icon={p.status === 'active' ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                  onClick={() => toggle.mutate(p._id)}
                  loading={toggle.isPending}
                >
                  {p.status === 'active' ? 'Pausar' : 'Retomar'}
                </Button>
                <Button icon={<EditOutlined />} onClick={() => openEdit(p)}>Editar</Button>
                <Popconfirm title="Remover postagem?" onConfirm={() => remove.mutate(p._id)} okText="Remover" okButtonProps={{ danger: true }}>
                  <Button danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            </div>
          </Card>
        ))}
      </Space>

      <PostModal
        open={modalOpen}
        post={editPost}
        agentId={editPost?.agentId ?? currentAgentId}
        agents={agents}
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}
