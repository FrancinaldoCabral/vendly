import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import Connections from './pages/Connections';
import KnowledgeBase from './pages/KnowledgeBase';
import ScheduledPosts from './pages/ScheduledPosts';
import Conversations from './pages/Conversations';
import Settings from './pages/Settings';

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<PrivateRoute><Dashboard /></PrivateRoute>} />
          <Route path="/connections" element={<PrivateRoute><Connections /></PrivateRoute>} />
          <Route path="/agents" element={<PrivateRoute><Agents /></PrivateRoute>} />
          <Route path="/knowledge" element={<PrivateRoute><KnowledgeBase /></PrivateRoute>} />
          <Route path="/scheduled-posts" element={<PrivateRoute><ScheduledPosts /></PrivateRoute>} />
          <Route path="/conversations" element={<PrivateRoute><Conversations /></PrivateRoute>} />
          <Route path="/settings" element={<PrivateRoute><Settings /></PrivateRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
