import { Card, Col, Row, Statistic, Typography, Badge } from 'antd';
import { RobotOutlined, MessageOutlined, CalendarOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

const { Title, Paragraph } = Typography;

export default function Dashboard() {
  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: api.getAgents });
  const { data: posts = [] } = useQuery({ queryKey: ['scheduled_posts'], queryFn: () => api.getScheduledPosts() });
  const { data: convs } = useQuery({ queryKey: ['conversations', {}], queryFn: () => api.getConversations({ limit: '1' }) });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.getMe });

  const activeAgents = agents.filter(a => a.status === 'active').length;
  const activePosts = posts.filter(p => p.status === 'active').length;

  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}>
        Bem-vindo{me?.name ? `, ${me.name}` : ''}!
      </Title>
      <Paragraph type="secondary">
        Gerencie seus agentes de WhatsApp, base de conhecimento e postagens agendadas.
      </Paragraph>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Total de agentes"
              value={agents.length}
              prefix={<RobotOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Agentes ativos"
              value={activeAgents}
              prefix={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Postagens agendadas"
              value={activePosts}
              prefix={<CalendarOutlined style={{ color: '#1677ff' }} />}
              valueStyle={{ color: '#1677ff' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Total de conversas"
              value={convs?.total ?? 0}
              prefix={<MessageOutlined style={{ color: '#722ed1' }} />}
              valueStyle={{ color: '#722ed1' }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title={<span><RobotOutlined /> Agentes</span>}>
            {agents.length === 0 ? (
              <Paragraph type="secondary">Nenhum agente criado ainda. Vá em <strong>Agentes</strong> para criar o primeiro.</Paragraph>
            ) : (
              agents.map(a => (
                <div key={a._id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <span>{a.name}</span>
                  <Badge
                    status={a.status === 'active' ? 'success' : a.status === 'pending_qr' ? 'warning' : 'default'}
                    text={a.status === 'active' ? 'Ativo' : a.status === 'pending_qr' ? 'Aguardando QR' : a.status}
                  />
                </div>
              ))
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={<span><CalendarOutlined /> Postagens agendadas</span>}>
            {posts.length === 0 ? (
              <Paragraph type="secondary">Nenhuma postagem agendada. Crie em <strong>Postagens agendadas</strong>.</Paragraph>
            ) : (
              posts.slice(0, 5).map(p => {
                const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
                const dayStr = p.schedule.days.map(d => days[d]).join(', ');
                return (
                  <div key={p._id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                    <span style={{ fontSize: 13 }}>{dayStr} às {p.schedule.time}</span>
                    <Badge
                      status={p.status === 'active' ? 'success' : 'default'}
                      text={p.status === 'active' ? 'Ativo' : 'Pausado'}
                    />
                  </div>
                );
              })
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
