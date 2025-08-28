/*
 * Copyright 2025 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fetch from 'cross-fetch';

import {
  createApiRef,
  DiscoveryApi,
  IdentityApi,
} from '@backstage/core-plugin-api';
import { parseEntityRef } from '@backstage/catalog-model';

export const bitbucketApiRef = createApiRef<BitbucketApi>({
  id: 'plugin.bitbucket.service',
});

export type User = {
  displayName: string;
  slug: string;
  // Additional fields can be added here later as needed
};

export type BuildStatus = {
  cancelled: number;
  failed: number;
  inProgress: number;
  successful: number;
  unknown: number;
};

export type PullRequest = {
  id: number;
  title: string;
  author: User;
  createdDate: number;
  updatedDate: number;
  state: string;
  description: string;
  url: string;
  repoUrl: string;
  fromRepo: string;
  fromProject: string;
  sourceBranch: string;
  targetBranch: string;
  latestCommit?: string;
  buildStatus?: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED' | 'UNKNOWN';
  reviewers: User[];
};
// TODO: this is currently listed as DEFAULT but it can't be changed.  Either fix the name or make it configurable
const DEFAULT_PROXY_PATH = '/bitbucket/api';
type Options = {
  discoveryApi: DiscoveryApi;
  identityApi: IdentityApi;
};
export class BitbucketApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly identityApi: IdentityApi;

  constructor(options: Options) {
    this.discoveryApi = options.discoveryApi;
    this.identityApi = options.identityApi;
  }

  async fetchPullRequestListForRepo(
    project: string,
    repo: string,
    state?: string,
  ): Promise<PullRequest[]> {
    const proxyUrl = await this.discoveryApi.getBaseUrl('proxy');
    const response = await fetch(
      `${proxyUrl}${DEFAULT_PROXY_PATH}/projects/${project}/repos/${repo}/pull-requests?state=${
        state || ''
      }`,
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
    if (!response.ok) {
      throw new Error('Failed to fetch pull requests');
    }

    const data = await response.json();
    return this.mapPullRequests(data);
  }

  private async fetchBuildStatus(commitId: string): Promise<BuildStatus> {
    const proxyUrl = await this.discoveryApi.getBaseUrl('proxy');
    const response = await fetch(
      `${proxyUrl}${DEFAULT_PROXY_PATH}/rest/build-status/latest/commits/stats/${commitId}`,
      { headers: { 'Content-Type': 'application/json' } },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch build status for commit ${commitId}`);
    }

    return response.json();
  }

  private determineBuildState(
    status: BuildStatus,
  ): 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED' | undefined {
    if (status.failed > 0) return 'FAILED';
    if (status.inProgress > 0) return 'INPROGRESS';
    if (status.cancelled > 0) return 'STOPPED';
    if (status.successful > 0) return 'SUCCESSFUL';
    return undefined;
  }

  private async enhancePrWithBuildStatus(
    pr: PullRequest,
  ): Promise<PullRequest> {
    if (pr.latestCommit) {
      try {
        const buildStatus = await this.fetchBuildStatus(pr.latestCommit);
        return { ...pr, buildStatus: this.determineBuildState(buildStatus) };
      } catch (error) {
        return { ...pr, buildStatus: 'UNKNOWN' };
      }
    }
    return pr;
  }

  private mapPullRequests(data: any): PullRequest[] {
    return (
      data.values?.map((pr: any) => ({
        id: pr.id,
        title: pr.title,
        author: {
          displayName: pr.author.user.displayName,
          slug: pr.author.user.slug,
        },
        createdDate: pr.createdDate,
        updatedDate: pr.updatedDate,
        state: pr.state,
        url: pr.links.self[0].href,
        repoUrl: pr.fromRef.repository.links.self[0].href,
        description: pr.description || '',
        fromRepo: pr.fromRef.repository.name,
        fromProject: pr.fromRef.repository.project.key,
        sourceBranch: pr.fromRef.displayId,
        targetBranch: pr.toRef.displayId,
        latestCommit: pr.fromRef.latestCommit,
        reviewers:
          pr.reviewers?.map((r: any) => ({
            displayName: r.user.displayName,
            slug: r.user.slug,
          })) || [],
      })) || []
    );
  }

  async fetchUserPullRequests(
    role: 'REVIEWER' | 'AUTHOR' = 'REVIEWER',
    state: 'OPEN' | 'MERGED' | 'DECLINED' | 'ALL' = 'OPEN',
    // TODO: limit this or paginate it?
    limit: number = 50,
    options: { includeBuildStatus?: boolean } = { includeBuildStatus: true },
  ): Promise<PullRequest[]> {
    if (!this.identityApi) {
      throw new Error('Identity API is not available');
    }

    const { userEntityRef } = await this.identityApi.getBackstageIdentity();

    const { name } = parseEntityRef(userEntityRef);

    if (!name) {
      throw new Error('User not found');
    }

    const proxyUrl = await this.discoveryApi.getBaseUrl('proxy');
    const url = new URL(
      `${proxyUrl}${DEFAULT_PROXY_PATH}/dashboard/pull-requests`,
    );

    const params = new URLSearchParams({
      order: 'participant_status',
      limit: limit.toString(),
      state,
      role,
      // TODO: revert this
      // user: name,
      user: 'mbruhin',
    });

    const response = await fetch(`${url}?${params}`, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = 'Failed to fetch pull requests from Bitbucket';

      try {
        const errorJson = JSON.parse(errorText);

        if (
          response.status === 404 &&
          errorJson.errors?.[0]?.message?.includes('does not exist')
        ) {
          errorMessage = `User '${name}' not found in Bitbucket. Please ensure your Bitbucket account exists.`;
        }
      } catch (e) {
        // If we can't parse the error, we'll use the generic message
      }

      throw new Error(errorMessage);
    }

    const data = await response.json();
    const pullRequests = this.mapPullRequests(data);
    if (options.includeBuildStatus) {
      const enhancedPullRequests = await Promise.all(
        pullRequests.map(pr => this.enhancePrWithBuildStatus(pr)),
      );
      return enhancedPullRequests;
    }
    return pullRequests;
  }
}
