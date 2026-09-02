import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

// CCC seam (sweep F6): bound the free-text search query so an unbounded value can't drive pg-tsquery's
// O(N²) regex backtracking (ReDoS / event-loop block). The global ValidationPipe rejects an over-length
// query with 400 at the edge for every search route; the fork's PdpSearchService applies the same bound
// defensively (incl. the @Public share path). See UPSTREAM_MODIFICATIONS.md.
export const MAX_SEARCH_QUERY_LENGTH = 1024;

export class SearchDTO {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_SEARCH_QUERY_LENGTH)
  query: string;

  @IsOptional()
  @IsUUID()
  spaceId: string;

  @IsOptional()
  @IsString()
  shareId?: string;

  @IsOptional()
  @IsUUID()
  creatorId?: string;

  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsNumber()
  offset?: number;
}

export class SearchShareDTO extends SearchDTO {
  @IsNotEmpty()
  @IsString()
  shareId: string;

  @IsOptional()
  @IsUUID()
  spaceId: string;
}

export class SearchSuggestionDTO {
  @IsString()
  @MaxLength(MAX_SEARCH_QUERY_LENGTH)
  query: string;

  @IsOptional()
  @IsBoolean()
  includeUsers?: boolean;

  @IsOptional()
  @IsBoolean()
  includeGroups?: boolean;

  @IsOptional()
  @IsBoolean()
  includePages?: boolean;

  @IsOptional()
  @IsString()
  spaceId?: string;

  @IsOptional()
  @IsNumber()
  limit?: number;
}
