do $$
declare t text;
begin
  foreach t in array array[
    'profiles','user_roles','posts','comments','likes','reposts','bookmarks','poll_votes','post_impressions',
    'follows','stories','story_likes','spaces','space_participants','space_messages','conversations','messages',
    'message_reactions','calls','notifications','monetization_settings','tips','payments','payouts','subscriptions',
    'user_preferences','feed_preferences','branding_settings','reports','audit_logs','system_settings',
    'support_tickets','support_ticket_messages','api_keys','webhooks','workspaces','workspace_members']
  loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array[
    'profiles','posts','comments','likes','reposts','poll_votes','follows','stories','story_likes',
    'spaces','space_participants','space_messages','system_settings','branding_settings']
  loop
    execute format('grant select on public.%I to anon', t);
  end loop;
end $$;

create policy "profiles public read" on public.profiles for select using (true);
create policy "profiles self update" on public.profiles for update to authenticated using (auth_user_id = auth.uid() or public.is_staff());
create policy "profiles self insert" on public.profiles for insert to authenticated with check (auth_user_id = auth.uid());

create policy "posts public read" on public.posts for select using (not hidden or public.owns_profile(user_id) or public.is_staff());
create policy "posts owner write" on public.posts for insert to authenticated with check (public.owns_profile(user_id));
create policy "posts owner update" on public.posts for update to authenticated using (public.owns_profile(user_id) or public.is_staff());
create policy "posts owner delete" on public.posts for delete to authenticated using (public.owns_profile(user_id) or public.is_staff());

create policy "comments public read" on public.comments for select using (true);
create policy "comments owner write" on public.comments for insert to authenticated with check (public.owns_profile(user_id));
create policy "comments owner delete" on public.comments for delete to authenticated using (public.owns_profile(user_id) or public.is_staff());

create policy "likes public read" on public.likes for select using (true);
create policy "likes owner write" on public.likes for insert to authenticated with check (public.owns_profile(user_id));
create policy "likes owner delete" on public.likes for delete to authenticated using (public.owns_profile(user_id));

create policy "reposts public read" on public.reposts for select using (true);
create policy "reposts owner write" on public.reposts for insert to authenticated with check (public.owns_profile(user_id));
create policy "reposts owner delete" on public.reposts for delete to authenticated using (public.owns_profile(user_id));

create policy "poll votes public read" on public.poll_votes for select using (true);
create policy "poll votes owner write" on public.poll_votes for insert to authenticated with check (public.owns_profile(user_id));

create policy "follows public read" on public.follows for select using (true);
create policy "follows owner write" on public.follows for insert to authenticated with check (public.owns_profile(follower_id));
create policy "follows owner delete" on public.follows for delete to authenticated using (public.owns_profile(follower_id));

create policy "stories public read" on public.stories for select using (expires_at > now() or public.owns_profile(user_id) or public.is_staff());
create policy "stories owner write" on public.stories for insert to authenticated with check (public.owns_profile(user_id));
create policy "stories owner update" on public.stories for update to authenticated using (public.owns_profile(user_id) or public.is_staff());
create policy "stories owner delete" on public.stories for delete to authenticated using (public.owns_profile(user_id) or public.is_staff());

create policy "story likes public read" on public.story_likes for select using (true);
create policy "story likes owner write" on public.story_likes for insert to authenticated with check (public.owns_profile(user_id));
create policy "story likes owner delete" on public.story_likes for delete to authenticated using (public.owns_profile(user_id));

create policy "spaces public read" on public.spaces for select using (true);
create policy "spaces host write" on public.spaces for insert to authenticated with check (public.owns_profile(host_id));
create policy "spaces host update" on public.spaces for update to authenticated using (public.owns_profile(host_id) or public.is_staff());
create policy "spaces host delete" on public.spaces for delete to authenticated using (public.owns_profile(host_id) or public.is_staff());

create policy "space participants public read" on public.space_participants for select using (true);
create policy "space participants self write" on public.space_participants for insert to authenticated with check (public.owns_profile(user_id));
create policy "space participants self update" on public.space_participants for update to authenticated
  using (public.owns_profile(user_id) or exists (select 1 from public.spaces s where s.id = space_id and public.owns_profile(s.host_id)));
create policy "space participants self delete" on public.space_participants for delete to authenticated
  using (public.owns_profile(user_id) or exists (select 1 from public.spaces s where s.id = space_id and public.owns_profile(s.host_id)));

create policy "space messages public read" on public.space_messages for select using (true);
create policy "space messages self write" on public.space_messages for insert to authenticated with check (public.owns_profile(user_id));
create policy "space messages self delete" on public.space_messages for delete to authenticated using (public.owns_profile(user_id) or public.is_staff());

create policy "branding public read" on public.branding_settings for select using (true);
create policy "branding owner write" on public.branding_settings for insert to authenticated with check (public.owns_profile(user_id));
create policy "branding owner update" on public.branding_settings for update to authenticated using (public.owns_profile(user_id));

create policy "system settings read" on public.system_settings for select using (true);
create policy "system settings admin write" on public.system_settings for update to authenticated using (public.has_role(auth.uid(),'admin'));

create policy "roles self read" on public.user_roles for select to authenticated using (user_id = auth.uid() or public.is_staff());
create policy "roles admin write" on public.user_roles for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

create policy "bookmarks owner all" on public.bookmarks for all to authenticated
  using (public.owns_profile(user_id)) with check (public.owns_profile(user_id));

create policy "impressions insert" on public.post_impressions for insert to authenticated with check (user_id is null or public.owns_profile(user_id));
create policy "impressions read" on public.post_impressions for select to authenticated
  using (public.is_staff() or exists (select 1 from public.posts p where p.id = post_id and public.owns_profile(p.user_id)));

create policy "conversations participant read" on public.conversations for select to authenticated
  using (public.owns_profile(user_a) or public.owns_profile(user_b));
create policy "conversations participant write" on public.conversations for insert to authenticated
  with check (public.owns_profile(user_a) or public.owns_profile(user_b));
create policy "conversations participant update" on public.conversations for update to authenticated
  using (public.owns_profile(user_a) or public.owns_profile(user_b));

create policy "messages participant read" on public.messages for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id and (public.owns_profile(c.user_a) or public.owns_profile(c.user_b))));
create policy "messages sender write" on public.messages for insert to authenticated
  with check (public.owns_profile(sender_id) and exists (select 1 from public.conversations c where c.id = conversation_id and (public.owns_profile(c.user_a) or public.owns_profile(c.user_b))));
create policy "messages participant update" on public.messages for update to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id and (public.owns_profile(c.user_a) or public.owns_profile(c.user_b))));
create policy "messages sender delete" on public.messages for delete to authenticated using (public.owns_profile(sender_id));

create policy "reactions participant read" on public.message_reactions for select to authenticated
  using (exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
                 where m.id = message_id and (public.owns_profile(c.user_a) or public.owns_profile(c.user_b))));
create policy "reactions self write" on public.message_reactions for insert to authenticated with check (public.owns_profile(user_id));
create policy "reactions self delete" on public.message_reactions for delete to authenticated using (public.owns_profile(user_id));

create policy "calls participant read" on public.calls for select to authenticated
  using (public.owns_profile(caller_id) or public.owns_profile(callee_id));
create policy "calls participant write" on public.calls for insert to authenticated with check (public.owns_profile(caller_id));
create policy "calls participant update" on public.calls for update to authenticated
  using (public.owns_profile(caller_id) or public.owns_profile(callee_id));

create policy "notifications owner read" on public.notifications for select to authenticated using (public.owns_profile(recipient_id));
create policy "notifications insert" on public.notifications for insert to authenticated with check (true);
create policy "notifications owner update" on public.notifications for update to authenticated using (public.owns_profile(recipient_id));
create policy "notifications owner delete" on public.notifications for delete to authenticated using (public.owns_profile(recipient_id));

create policy "monetization owner all" on public.monetization_settings for all to authenticated
  using (public.owns_profile(user_id)) with check (public.owns_profile(user_id));

create policy "tips participant read" on public.tips for select to authenticated
  using (public.owns_profile(from_user_id) or public.owns_profile(to_user_id) or public.is_staff());

create policy "payments owner read" on public.payments for select to authenticated using (public.owns_profile(user_id) or public.is_staff());
create policy "payouts owner read" on public.payouts for select to authenticated using (public.owns_profile(user_id) or public.is_staff());
create policy "subscriptions owner read" on public.subscriptions for select to authenticated using (public.owns_profile(user_id) or public.is_staff());

create policy "prefs owner all" on public.user_preferences for all to authenticated
  using (public.owns_profile(user_id)) with check (public.owns_profile(user_id));
create policy "feed prefs owner all" on public.feed_preferences for all to authenticated
  using (public.owns_profile(user_id)) with check (public.owns_profile(user_id));

create policy "reports reporter insert" on public.reports for insert to authenticated with check (public.owns_profile(reporter_id));
create policy "reports read" on public.reports for select to authenticated using (public.owns_profile(reporter_id) or public.is_staff());
create policy "reports staff update" on public.reports for update to authenticated using (public.is_staff());

create policy "audit staff read" on public.audit_logs for select to authenticated using (public.is_staff());

create policy "tickets owner all" on public.support_tickets for all to authenticated
  using (public.owns_profile(user_id) or public.is_staff()) with check (public.owns_profile(user_id) or public.is_staff());
create policy "ticket messages read" on public.support_ticket_messages for select to authenticated
  using (public.is_staff() or exists (select 1 from public.support_tickets t where t.id = ticket_id and public.owns_profile(t.user_id)));
create policy "ticket messages write" on public.support_ticket_messages for insert to authenticated
  with check (public.is_staff() or exists (select 1 from public.support_tickets t where t.id = ticket_id and public.owns_profile(t.user_id)));

create policy "api keys owner all" on public.api_keys for all to authenticated
  using (public.owns_profile(user_id)) with check (public.owns_profile(user_id));
create policy "webhooks owner all" on public.webhooks for all to authenticated
  using (public.owns_profile(user_id)) with check (public.owns_profile(user_id));

create policy "workspaces member read" on public.workspaces for select to authenticated
  using (public.is_workspace_member(id, public.current_profile_id()));
create policy "workspaces owner write" on public.workspaces for insert to authenticated with check (public.owns_profile(owner_id));
create policy "workspaces owner update" on public.workspaces for update to authenticated using (public.owns_profile(owner_id));
create policy "workspaces owner delete" on public.workspaces for delete to authenticated using (public.owns_profile(owner_id));

create policy "workspace members read" on public.workspace_members for select to authenticated
  using (public.is_workspace_member(workspace_id, public.current_profile_id()));
create policy "workspace members owner write" on public.workspace_members for all to authenticated
  using (exists (select 1 from public.workspaces w where w.id = workspace_id and public.owns_profile(w.owner_id)))
  with check (exists (select 1 from public.workspaces w where w.id = workspace_id and public.owns_profile(w.owner_id)));