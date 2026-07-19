import { useNavigate } from 'react-router-dom';
import AuthPage from '../components/auth/AuthPage';
import { routes } from '../lib/routes';

export default function LoginPage() {
  const navigate = useNavigate();

  return (
    <div className="h-full overflow-y-auto bg-oct-bg">
      <AuthPage onAuth={() => navigate(routes.home)} />
    </div>
  );
}
