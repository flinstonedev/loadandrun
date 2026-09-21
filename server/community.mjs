import {uid, now, fail} from './model.mjs';
import {fetchGitHubRepository} from './github.mjs';

const list = (state, key) => state[key] || [];
const byId = (state, key, id) => list(state, key).find(record => record.id === id);
const member = (record, user) => Boolean(user && (record?.owner === user.id || record?.members?.includes(user.id)));
const groupMember = (state, groupId, user) => member(byId(state, 'groups', groupId), user);
const groupOwner = (state, groupId, user) => Boolean(user && byId(state, 'groups', groupId)?.owner === user.id);
const projectMember = (state, project, user) => Boolean(project && user
  && (!project.groupId || groupMember(state, project.groupId, user))
  && (member(project, user) || groupOwner(state, project.groupId, user)));
const projectManager = (state, project, user) => Boolean(user
  && (project.owner === user.id || groupOwner(state, project.groupId, user)));
const author = (state, owner) => ({id: owner, name: byId(state, 'users', owner)?.name || 'Builder'});
const recent = records => [...records].sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id));

function inputText(value, label, max, optional = false) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) {
    fail(`Enter ${label.toLowerCase()}${max ? ` using at most ${max} characters` : ''}.`);
  }
  return value.trim();
}

function inputId(value, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('Choose a valid item.');
  return value;
}

function httpsUrl(value, label) {
  const raw = inputText(value, label, 2000);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return parsed.href;
  } catch {}
  fail(`Use a complete HTTPS link for ${label.toLowerCase()}.`);
}

function requireUser(state, user) {
  if (!user || !byId(state, 'users', user.id)) fail('Sign in to participate in the community.', 401);
}

function requireGroup(state, id) {
  const group = byId(state, 'groups', id);
  if (!group) fail('Group not found.', 404);
  return group;
}

function requireProject(state, id) {
  const project = byId(state, 'projects', id);
  if (!project) fail('Project not found.', 404);
  return project;
}

function publishedIdea(state, address, optional = false, catalogAddresses) {
  const id = inputId(address, optional);
  const published = Array.isArray(catalogAddresses) && catalogAddresses.includes(id);
  if (id && !published) {
    fail('Choose a published idea from the library.');
  }
  return id;
}

function canReadPost(state, post, user) {
  if (!post || post.deleted) return false;
  if (post.visibility === 'public') return true;
  if (post.visibility !== 'members') return false;
  if (post.projectId) return projectMember(state, byId(state, 'projects', post.projectId), user);
  return Boolean(post.groupId && groupMember(state, post.groupId, user));
}

function canManagePost(state, post, user) {
  return Boolean(user && (post.owner === user.id || groupOwner(state, post.groupId, user)
    || (post.projectId && byId(state, 'projects', post.projectId)?.owner === user.id)));
}

function requirePost(state, id, user) {
  const post = byId(state, 'posts', id);
  if (!canReadPost(state, post, user)) fail('Post not found.', 404);
  return post;
}

function visiblePosts(state, user) {
  return recent(list(state, 'posts').filter(post => canReadPost(state, post, user)));
}

function decoratePost(state, post, user) {
  return {...post, author: author(state, post.owner),
    commentCount: list(state, 'comments').filter(comment => comment.postId === post.id && !comment.deleted).length,
    reactionCount: list(state, 'reactions').filter(reaction => reaction.postId === post.id).length,
    reacted: Boolean(user && list(state, 'reactions').some(reaction => reaction.postId === post.id && reaction.owner === user.id)),
    isOwner: post.owner === user?.id, canManage: canManagePost(state, post, user)};
}

function decorateGroup(state, group, user) {
  return {...group, memberCount: new Set([group.owner, ...(group.members || [])]).size,
    projectCount: list(state, 'projects').filter(project => project.groupId === group.id).length,
    postCount: visiblePosts(state, user).filter(post => post.groupId === group.id).length,
    joined: member(group, user), isOwner: group.owner === user?.id, canManage: group.owner === user?.id,
    author: author(state, group.owner)};
}

function decorateProject(state, project, user) {
  const group = project.groupId ? byId(state, 'groups', project.groupId) : null;
  const activeMembers = [...new Set([project.owner, ...(project.members || [])])]
    .filter(id => !group || member(group, {id}));
  return {...project, memberCount: activeMembers.length,
    postCount: visiblePosts(state, user).filter(post => post.projectId === project.id).length,
    joined: projectMember(state, project, user), isOwner: project.owner === user?.id,
    canManage: projectManager(state, project, user), author: author(state, project.owner),
    groupName: group?.name || null};
}

const memberProfiles = (state, record) => [...new Set([record.owner, ...(record.members || [])])]
  .map(id => byId(state, 'users', id)).filter(Boolean).map(user => ({id: user.id, name: user.name}));

// All mutation callbacks remain synchronous for SQLite-backed Durable Objects.
// Github fetching is the one external operation; permission is checked again
// against the current state before its result is committed.
export async function handleCommunity({endpoint, method, body = {}, store, user, catalogAddresses, fetchRepository = fetchGitHubRepository}) {
  if (endpoint !== 'community' && !endpoint.startsWith('community/')) return null;
  if (!['GET', 'POST'].includes(method)) fail('Method not allowed.', 405);
  if (method === 'POST' && (!body || typeof body !== 'object' || Array.isArray(body))) fail('Choose valid form values.');
  const state = store.read();
  const checkIdea = (next, address, optional = false) => publishedIdea(next, address, optional, catalogAddresses);
  if (method === 'POST') requireUser(state, user);
  const send = (result, status = 200) => ({body: result, status});
  const mutate = async (callback, status = 200) => send(await store.transaction(next => {
    requireUser(next, user);
    return callback(next);
  }), status);

  if (endpoint === 'community' && method === 'GET') {
    return send({groups: recent(list(state, 'groups')).map(group => decorateGroup(state, group, user)),
      projects: recent(list(state, 'projects')).map(project => decorateProject(state, project, user)),
      posts: visiblePosts(state, user).map(post => decoratePost(state, post, user))});
  }

  if (endpoint === 'community/groups' && method === 'POST') {
    const name = inputText(body.name, 'a group name', 100);
    const description = inputText(body.description, 'a group description', 2000);
    const topic = inputText(body.topic, 'a topic', 100, true);
    return mutate(next => {
      const group = {id: uid(), owner: user.id, name, description, topic, members: [user.id], created: now()};
      (next.groups ||= []).push(group);
      return decorateGroup(next, group, user);
    }, 201);
  }

  const groupRoute = endpoint.match(/^community\/groups\/([^/]+)(?:\/(join|leave))?$/);
  if (groupRoute) {
    const id = inputId(groupRoute[1]), action = groupRoute[2];
    const group = requireGroup(state, id);
    if (!action && method === 'GET') {
      return send({group: decorateGroup(state, group, user),
        projects: recent(list(state, 'projects').filter(project => project.groupId === id)).map(project => decorateProject(state, project, user)),
        posts: visiblePosts(state, user).filter(post => post.groupId === id).map(post => decoratePost(state, post, user)),
        members: memberProfiles(state, group)});
    }
    if (action && method === 'POST') return mutate(next => {
      const current = requireGroup(next, id);
      current.members ||= [current.owner];
      if (action === 'join' && !current.members.includes(user.id)) current.members.push(user.id);
      if (action === 'leave') {
        if (current.owner === user.id) fail('The group owner must remain a member.', 409);
        current.members = current.members.filter(id => id !== user.id);
        for (const project of list(next, 'projects').filter(project => project.groupId === id)) {
          project.members = (project.members || []).filter(id => id !== user.id);
        }
      }
      return decorateGroup(next, current, user);
    });
  }

  if (endpoint === 'community/projects' && method === 'POST') {
    const title = inputText(body.title, 'a project title', 150);
    const goal = inputText(body.goal, 'a project goal', 3000);
    const helpNeeded = inputText(body.helpNeeded, 'the help you need', 1000, true);
    const groupId = inputId(body.groupId, true);
    return mutate(next => {
      const ideaAddress = checkIdea(next, body.ideaAddress, true);
      if (groupId) {
        requireGroup(next, groupId);
        if (!groupMember(next, groupId, user)) fail('Join this group before creating a project in it.', 403);
      }
      const project = {id: uid(), owner: user.id, title, goal, helpNeeded, ideaAddress, groupId,
        members: [user.id], stage: 'forming', repository: null, created: now()};
      (next.projects ||= []).push(project);
      return decorateProject(next, project, user);
    }, 201);
  }

  const projectRoute = endpoint.match(/^community\/projects\/([^/]+)(?:\/(join|repository|settings))?$/);
  if (projectRoute) {
    const id = inputId(projectRoute[1]), action = projectRoute[2];
    const project = requireProject(state, id);
    if (!action && method === 'GET') {
      return send({project: decorateProject(state, project, user),
        posts: visiblePosts(state, user).filter(post => post.projectId === id).map(post => decoratePost(state, post, user)),
        members: memberProfiles(state, project).filter(member => !project.groupId || groupMember(state, project.groupId, member))});
    }
    if (action === 'join' && method === 'POST') return mutate(next => {
      const current = requireProject(next, id);
      if (current.groupId && !groupMember(next, current.groupId, user)) fail('Join the hosting group before joining this project.', 403);
      current.members ||= [current.owner];
      if (!current.members.includes(user.id)) current.members.push(user.id);
      return decorateProject(next, current, user);
    });
    if (action === 'repository' && method === 'POST') {
      if (!projectManager(state, project, user)) fail('Only the project or group owner can change its repository.', 403);
      const repository = body.url === '' ? null : await fetchRepository(body.url);
      return mutate(next => {
        const current = requireProject(next, id);
        if (!projectManager(next, current, user)) fail('Only the project or group owner can change its repository.', 403);
        current.repository = repository;
        current.repositoryLinkedBy = repository ? user.id : null;
        return decorateProject(next, current, user);
      });
    }
    if (action === 'settings' && method === 'POST') return mutate(next => {
      const current = requireProject(next, id);
      if (!projectManager(next, current, user)) fail('Only the project or group owner can update its settings.', 403);
      if (body.stage !== undefined) {
        if (!['forming', 'building', 'testing', 'shipped'].includes(body.stage)) fail('Choose a valid project stage.');
        current.stage = body.stage;
      }
      if (body.goal !== undefined) current.goal = inputText(body.goal, 'a project goal', 3000);
      if (body.helpNeeded !== undefined) current.helpNeeded = inputText(body.helpNeeded, 'the help you need', 1000, true);
      return decorateProject(next, current, user);
    });
  }

  if (endpoint === 'community/posts' && method === 'POST') {
    const content = inputText(body.content, 'an update', 5000);
    const visibility = body.visibility === undefined ? 'public' : body.visibility;
    const kind = body.kind === undefined ? 'update' : body.kind;
    if (!['public', 'members'].includes(visibility)) fail('Choose public or members-only visibility.');
    if (!['update', 'help'].includes(kind)) fail('Choose an update or a request for help.');
    const requestedGroup = inputId(body.groupId, true), projectId = inputId(body.projectId, true);
    return mutate(next => {
      const project = projectId ? requireProject(next, projectId) : null;
      if (project && !projectMember(next, project, user)) fail('Join this project before posting an update.', 403);
      if (project && requestedGroup && project.groupId !== requestedGroup) fail('The project does not belong to this group.');
      const groupId = project?.groupId || requestedGroup;
      if (groupId) {
        requireGroup(next, groupId);
        if (!groupMember(next, groupId, user)) fail('Join this group before posting an update.', 403);
      }
      if (visibility === 'members' && !groupId && !projectId) fail('Choose a group or project for a members-only update.');
      const ideaAddress = checkIdea(next, body.ideaAddress || project?.ideaAddress, true);
      if (project?.ideaAddress && ideaAddress !== project.ideaAddress) fail('Use this project’s linked idea for its updates.');
      const post = {id: uid(), owner: user.id, content, visibility, kind, groupId, projectId, ideaAddress, created: now()};
      (next.posts ||= []).push(post);
      return decoratePost(next, post, user);
    }, 201);
  }

  const postRoute = endpoint.match(/^community\/posts\/([^/]+)(?:\/(comments|react|remove))?$/);
  if (postRoute) {
    const id = inputId(postRoute[1]), action = postRoute[2];
    const post = requirePost(state, id, user);
    if (!action && method === 'GET') {
      return send({post: decoratePost(state, post, user),
        comments: list(state, 'comments').filter(comment => comment.postId === id && !comment.deleted)
          .map(comment => ({...comment, author: author(state, comment.owner), isOwner: comment.owner === user?.id}))});
    }
    if (action && method === 'POST') return mutate(next => {
      const current = requirePost(next, id, user);
      if (action === 'comments') {
        const comment = {id: uid(), postId: id, owner: user.id, content: inputText(body.content, 'a comment', 3000), created: now()};
        (next.comments ||= []).push(comment);
        return {...comment, author: author(next, user.id), isOwner: true};
      }
      if (action === 'react') {
        next.reactions ||= [];
        const existing = next.reactions.find(reaction => reaction.postId === id && reaction.owner === user.id);
        if (existing) next.reactions = next.reactions.filter(reaction => reaction.id !== existing.id);
        else next.reactions.push({id: uid(), postId: id, owner: user.id, created: now()});
        return {reacted: !existing, reactionCount: next.reactions.filter(reaction => reaction.postId === id).length};
      }
      if (!canManagePost(next, current, user)) fail('Only the author or community owner can remove this update.', 403);
      current.deleted = true;
      return {ok: true};
    }, action === 'comments' ? 201 : 200);
  }

  if (endpoint === 'community/bookmarks') {
    requireUser(state, user);
    if (method === 'GET') return send(recent(list(state, 'bookmarks').filter(bookmark => bookmark.owner === user.id)));
    return mutate(next => {
      const ideaAddress = checkIdea(next, body.ideaAddress);
      next.bookmarks ||= [];
      const existing = next.bookmarks.find(bookmark => bookmark.owner === user.id && bookmark.ideaAddress === ideaAddress);
      if (existing) next.bookmarks = next.bookmarks.filter(bookmark => bookmark.id !== existing.id);
      else next.bookmarks.push({id: uid(), owner: user.id, ideaAddress, created: now()});
      return {saved: !existing, ideaAddress};
    });
  }

  if (endpoint === 'community/ideas' && method === 'POST') {
    const title = inputText(body.title, 'an idea title', 150);
    const summary = inputText(body.summary, 'an idea summary', 5000);
    const sourceUrl = httpsUrl(body.sourceUrl, 'source material');
    const licenseUrl = httpsUrl(body.licenseUrl, 'license evidence');
    return mutate(next => {
      const submission = {id: uid(), owner: user.id, title, summary, sourceUrl, licenseUrl, status: 'pending', created: now()};
      (next.ideaSubmissions ||= []).push(submission);
      return {id: submission.id, status: submission.status};
    }, 201);
  }

  if (endpoint === 'community/reports' && method === 'POST') {
    const postId = inputId(body.postId), reason = inputText(body.reason, 'a reason for reporting this update', 2000);
    return mutate(next => {
      requirePost(next, postId, user);
      next.reports ||= [];
      if (!next.reports.some(report => report.postId === postId && report.owner === user.id)) {
        next.reports.push({id: uid(), owner: user.id, postId, reason, status: 'pending', created: now()});
      }
      return {ok: true};
    }, 201);
  }
  fail('Community page not found.', 404);
}
