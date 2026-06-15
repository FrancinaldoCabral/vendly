import { Navigate } from 'react-router-dom';

// Agents are now managed inside each WhatsApp (see Connections page).
export default function Agents() {
  return <Navigate to="/connections" replace />;
}
