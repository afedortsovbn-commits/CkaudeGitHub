import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import { Center, Loader, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, useAuth } from './lib/auth';
import { AuditPage, SettingsPage } from './pages/AdminPages';
import { ProfilePage } from './pages/ProfilePage';
import { PrivacyPage } from './pages/PrivacyPage';
import { HomePage, Layout } from './pages/Layout';
import { LoginPage } from './pages/LoginPage';
import { MatrixPage } from './pages/MatrixPage';
import { DepartmentsPage, DictionariesPage, EnterprisesPage, ObjectsPage } from './pages/OrgPages';
import { SupervisorPage } from './pages/SupervisorPage';
import { ReportsPage } from './pages/ReportsPage';
import { TopicsPage } from './pages/TopicsPage';
import { CabinetPage, TicketControlPage, TicketPage } from './pages/TicketPages';
import { DemoLoginPage } from './pages/DemoLoginPage';
import { RolesPage } from './pages/RolesPage';
import { UsersPage } from './pages/UsersPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { ChannelsPage } from './pages/ChannelsPage';
import { DemoCallPage } from './pages/DemoCallPage';
import { FlowEditorPage, FlowListPage } from './pages/FlowEditorPage';
import { AnnouncementsPage, AudioLibraryPage, IntegrationsPage } from './pages/IvrAdminPages';
import {
  ApiDocsPage,
  ApiKeysPage,
  ConfigTransferPage,
  ExternalBotsPage,
  WebhooksPage,
} from './pages/IntegrationPages';
import { AssistProvidersPage, AutoRepliesPage, KnowledgePage, TemplatesPage } from './pages/AutomationPages';
import { ObjectSyncPage } from './pages/ObjectSyncPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function App() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  // Публичная демо-страница звонка — без входа сотрудника.
  if (loc.pathname.startsWith('/demo-call')) return <DemoCallPage />;
  // Демо-стенд: вход в один клик со страницы ссылок стенда (/demo-login?as=<email>).
  if (loc.pathname.startsWith('/demo-login')) return <DemoLoginPage />;
  if (loading)
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  if (!me) return <LoginPage />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="workspace" element={<WorkspacePage />} />
        <Route path="supervisor" element={<SupervisorPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="tickets" element={<CabinetPage />} />
        <Route path="tickets/:id" element={<TicketPage />} />
        <Route path="tickets-control" element={<TicketControlPage />} />
        <Route path="channels" element={<ChannelsPage />} />
        <Route path="ivr" element={<FlowListPage kind="voice" key="voice" />} />
        <Route path="ivr/:id" element={<FlowEditorPage />} />
        <Route path="ivr-audio" element={<AudioLibraryPage />} />
        <Route path="bots" element={<FlowListPage kind="text" key="text" />} />
        <Route path="bots/:id" element={<FlowEditorPage />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="kb" element={<KnowledgePage />} />
        <Route path="auto-replies" element={<AutoRepliesPage />} />
        <Route path="assist" element={<AssistProvidersPage />} />
        <Route path="announcements" element={<AnnouncementsPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="webhooks" element={<WebhooksPage />} />
        <Route path="external-bots" element={<ExternalBotsPage />} />
        <Route path="config-transfer" element={<ConfigTransferPage />} />
        <Route path="api-docs" element={<ApiDocsPage />} />
        <Route path="enterprises" element={<EnterprisesPage />} />
        <Route path="departments" element={<DepartmentsPage />} />
        <Route path="topics" element={<TopicsPage />} />
        <Route path="objects" element={<ObjectsPage />} />
        <Route path="objects-sync" element={<ObjectSyncPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="roles" element={<RolesPage />} />
        <Route path="matrix" element={<MatrixPage />} />
        <Route path="dictionaries" element={<DictionariesPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="*" element={<HomePage />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider>
      <Notifications position="bottom-right" />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
