## Signal Monitor

Automated daily fetch of water/energy/infrastructure signals from Google News RSS.

Stores results in Supabase `signals_raw` table for analysis.

### Queries monitored
- Data center water consumption/shortage
- Water rights acquisitions/sales
- Aquifer depletion/contamination
- Water stress events
- Cooling water regulation/bans
- Drought emergencies
- Network state physical infrastructure
- Water futures pricing
- Data center moratoriums
- Desalination projects

### Setup
1. Add `SUPABASE_KEY` to repository secrets
2. GitHub Actions runs daily at 06:00 UTC
3. Manual trigger available via workflow_dispatch
