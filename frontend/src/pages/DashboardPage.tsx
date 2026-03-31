/**
 * Dashboard — stats overview, recent runs, quick upload
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  FileText,
  TrendingUp,
  AlertTriangle,
  Clock,
  PlusCircle,
  ArrowRight,
  CheckCircle,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { runsApi, type RunSummary } from '../lib/api';
import { useAuth } from '../lib/auth';
import { StatCard, Card, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Table, type Column } from '../components/ui/Table';
import { DashboardSkeleton } from '../components/ui/Skeleton';
import { NoRunsEmpty } from '../components/ui/EmptyState';
import { PageWrapper } from '../components/ui/PageHeader';
import {
  formatDateTime,
  formatPct,
  matchRateColor,
  runStatusVariant,
  runStatusLabel,
  formatFY,
} from '../lib/utils';

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const { data: runs = [], isLoading } = useQuery({
    queryKey: ['runs'],
    queryFn: runsApi.list,
    refetchInterval: 15_000,
  });

  const { data: trendData } = useQuery({
    queryKey: ['variance-trends'],
    queryFn: () => runsApi.trends({ limit: 50 }),
    staleTime: 60_000,
  });

  const stats = useMemo(() => {
    const total = runs.length;
    const pending = runs.filter((r) => r.status === 'PENDING_REVIEW').length;
    const failed = runs.filter((r) => r.status === 'FAILED').length;
    const completed = runs.filter(
      (r) => r.status === 'APPROVED' || r.status === 'REJECTED',
    ).length;
    const matchRates = runs
      .filter((r) => r.match_rate_pct != null)
      .map((r) => r.match_rate_pct);
    const avgMatch =
      matchRates.length > 0
        ? matchRates.reduce((a, b) => a + b, 0) / matchRates.length
        : null;
    return { total, pending, failed, completed, avgMatch };
  }, [runs]);

  // Status distribution for donut chart
  const statusDistribution = useMemo(() => {
    const approved = runs.filter((r) => r.status === 'APPROVED').length;
    const pending = runs.filter((r) => r.status === 'PENDING_REVIEW').length;
    const processing = runs.filter((r) => r.status === 'PROCESSING').length;
    const failed = runs.filter((r) => r.status === 'FAILED').length;
    const rejected = runs.filter((r) => r.status === 'REJECTED').length;
    return [
      { name: 'Approved', value: approved, color: '#059669' },
      { name: 'Pending', value: pending, color: '#d97706' },
      { name: 'Processing', value: processing, color: '#2563eb' },
      { name: 'Failed', value: failed, color: '#dc2626' },
      { name: 'Rejected', value: rejected, color: '#9f1239' },
    ].filter((d) => d.value > 0);
  }, [runs]);

  // Recent 8 runs sorted by created_at desc
  const recentRuns = useMemo(
    () =>
      [...runs]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 8),
    [runs],
  );

  // Chart data: last 10 completed runs sorted ascending
  const chartData = useMemo(() => {
    return [...runs]
      .filter((r) => r.match_rate_pct != null && r.status !== 'PROCESSING' && r.status !== 'FAILED')
      .sort((a, b) => {
        const dateA = a.completed_at ? new Date(a.completed_at).getTime() : new Date(a.created_at).getTime();
        const dateB = b.completed_at ? new Date(b.completed_at).getTime() : new Date(b.created_at).getTime();
        return dateA - dateB;
      })
      .slice(-10)
      .map((r) => ({
        label: `Run #${r.run_number}`,
        match_rate: +r.match_rate_pct.toFixed(1),
      }));
  }, [runs]);

  const columns: Column<RunSummary>[] = [
    {
      key: 'run_number',
      header: 'Run #',
      sortable: true,
      render: (r) => (
        <span className="font-mono text-xs text-gray-600">#{r.run_number}</span>
      ),
    },
    {
      key: 'deductor_name',
      header: 'Deductor',
      sortable: true,
      render: (r) => (
        <div>
          <p className="text-sm font-medium text-gray-900 truncate max-w-[200px]">
            {r.deductor_name}
          </p>
          <p className="text-xs text-gray-400">{r.tan}</p>
        </div>
      ),
    },
    {
      key: 'financial_year',
      header: 'FY',
      render: (r) => (
        <span className="text-xs text-gray-600">{formatFY(r.financial_year)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <Badge variant={runStatusVariant(r.status)}>{runStatusLabel(r.status)}</Badge>
      ),
    },
    {
      key: 'match_rate_pct',
      header: 'Match Rate',
      align: 'right',
      sortable: true,
      render: (r) => (
        <span className={`${matchRateColor(r.match_rate_pct)} font-semibold`}>
          {formatPct(r.match_rate_pct)}
        </span>
      ),
    },
    {
      key: 'created_at',
      header: 'Created',
      sortable: true,
      render: (r) => (
        <span className="text-xs text-gray-500">{formatDateTime(r.created_at)}</span>
      ),
    },
  ];

  if (isLoading) return <DashboardSkeleton />;

  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  };

  return (
    <PageWrapper>
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {greeting()}, {user?.full_name?.split(' ')[0]}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            26AS TDS Reconciliation Platform · HRA &amp; Co.
          </p>
        </div>
        <button
          onClick={() => navigate('/runs/new')}
          className="flex items-center gap-2 px-4 py-2 bg-[#1B3A5C] text-white text-sm font-semibold rounded-lg hover:bg-[#15304d] transition-colors"
        >
          <PlusCircle className="h-4 w-4" />
          New Run
        </button>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Runs"
          value={stats.total}
          icon={<FileText className="h-5 w-5" />}
        />
        <StatCard
          label="Avg Match Rate"
          value={stats.avgMatch != null ? formatPct(stats.avgMatch) : '—'}
          sub="across all runs"
          icon={<TrendingUp className="h-5 w-5" />}
          accentColor={
            stats.avgMatch != null && stats.avgMatch >= 95
              ? 'text-emerald-600'
              : 'text-[#1B3A5C]'
          }
        />
        <StatCard
          label="Pending Review"
          value={stats.pending}
          sub={stats.pending > 0 ? 'require attention' : 'all clear'}
          icon={<Clock className="h-5 w-5" />}
          accentColor={stats.pending > 0 ? 'text-amber-600' : 'text-emerald-600'}
        />
        <StatCard
          label="Failed"
          value={stats.failed}
          icon={<AlertTriangle className="h-5 w-5" />}
          accentColor={stats.failed > 0 ? 'text-red-600' : 'text-emerald-600'}
        />
      </div>

      {/* Main content */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Recent runs table — takes 2 cols */}
        <div className="lg:col-span-2">
          <Card padding={false}>
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Recent Runs</h3>
                <p className="text-xs text-gray-400 mt-0.5">Latest reconciliation runs</p>
              </div>
              <button
                onClick={() => navigate('/runs')}
                className="text-xs text-[#1B3A5C] font-medium flex items-center gap-1 hover:underline"
              >
                View all <ArrowRight className="h-3 w-3" />
              </button>
            </div>
            {recentRuns.length === 0 ? (
              <NoRunsEmpty onNewRun={() => navigate('/runs/new')} />
            ) : (
              <Table
                columns={columns}
                data={recentRuns}
                keyExtractor={(r) => r.id}
                onRowClick={(r) => navigate(`/runs/${r.id}`)}
                emptyMessage="No runs yet."
              />
            )}
          </Card>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Match rate trend chart */}
          <Card>
            <div className="flex items-start justify-between mb-3">
              <CardHeader title="Match Rate Trend" subtitle="Last 10 completed runs" />
              {trendData && trendData.avg_match_rate != null && (
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                    trendData.trend_direction === 'improving' ? 'bg-emerald-100 text-emerald-700' :
                    trendData.trend_direction === 'declining' ? 'bg-red-100 text-red-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>
                    {trendData.trend_direction === 'improving' ? 'Improving' :
                     trendData.trend_direction === 'declining' ? 'Declining' : 'Stable'}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    Avg {trendData.avg_match_rate}% | Range {trendData.min_match_rate}–{trendData.max_match_rate}%
                  </span>
                </div>
              )}
            </div>
            {chartData.length >= 2 ? (
              <ResponsiveContainer width="100%" height={150}>
                <AreaChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="matchGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#1B3A5C" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#1B3A5C" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid #e5e7eb' }}
                    formatter={(v) => [`${v}%`, 'Match Rate']}
                  />
                  <Area
                    type="monotone"
                    dataKey="match_rate"
                    stroke="#1B3A5C"
                    strokeWidth={2}
                    fill="url(#matchGrad)"
                    dot={{ r: 3, fill: '#1B3A5C' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[150px] flex items-center justify-center text-xs text-gray-400">
                Need at least 2 completed runs
              </div>
            )}
          </Card>

          {/* Status distribution donut */}
          {statusDistribution.length > 0 && (
            <Card>
              <CardHeader title="Status Distribution" subtitle="All runs by status" />
              <div className="flex items-center gap-2">
                <ResponsiveContainer width={100} height={100}>
                  <PieChart>
                    <Pie
                      data={statusDistribution}
                      cx="50%"
                      cy="50%"
                      innerRadius={28}
                      outerRadius={45}
                      dataKey="value"
                      strokeWidth={2}
                      stroke="#fff"
                    >
                      {statusDistribution.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-1">
                  {statusDistribution.map((d) => (
                    <div key={d.name} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: d.color }}
                        />
                        <span className="text-gray-600">{d.name}</span>
                      </div>
                      <span className="font-semibold text-gray-900">{d.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}

          {/* Quick actions */}
          <Card>
            <CardHeader title="Quick Actions" />
            <div className="space-y-2">
              <button
                onClick={() => navigate('/runs/new')}
                className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg bg-[#1B3A5C] text-white text-sm font-medium hover:bg-[#15304d] transition-colors"
              >
                <PlusCircle className="h-4 w-4" />
                Start New Reconciliation
              </button>
              <button
                onClick={() => navigate('/runs')}
                className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg border border-gray-200 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                <FileText className="h-4 w-4 text-gray-400" />
                View All Runs
              </button>
              {stats.pending > 0 && (
                <button
                  onClick={() => navigate('/runs?status=PENDING_REVIEW')}
                  className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg border border-amber-200 text-amber-700 text-sm font-medium hover:bg-amber-50 transition-colors"
                >
                  <CheckCircle className="h-4 w-4" />
                  Review {stats.pending} pending run{stats.pending > 1 ? 's' : ''}
                </button>
              )}
            </div>
          </Card>

          {/* Compliance note */}
          <Card className="bg-blue-50 border-blue-100">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-blue-800">Compliance Note</p>
                <p className="text-xs text-blue-600 mt-0.5 leading-relaxed">
                  Over-claim rule: books_sum must not exceed 26AS amount. Approved runs are
                  eligible for client deliverables.
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </PageWrapper>
  );
}
