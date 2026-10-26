// Réponses factices imitant la forme des API réelles

const artistRun = (name, id = 'UC1') => ({
  text: name,
  navigationEndpoint: { browseEndpoint: { browseId: id, browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' } } } },
});
const albumRun = (name) => ({
  text: name,
  navigationEndpoint: { browseEndpoint: { browseId: 'MPRE1', browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' } } } },
});
const flex = (runs) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs } } });

export function ytmSong({ videoId, title, artist, album, duration, explicit = false }) {
  return {
    musicResponsiveListItemRenderer: {
      thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: `https://lh3.googleusercontent.com/${videoId}=w60-h60-l90-rj`, width: 60, height: 60 }, { url: `https://lh3.googleusercontent.com/${videoId}=w120-h120-l90-rj`, width: 120, height: 120 }] } } },
      flexColumns: [
        flex([{ text: title, navigationEndpoint: { watchEndpoint: { videoId } } }]),
        flex([{ text: 'Titre' }, { text: ' • ' }, artistRun(artist), { text: ' • ' }, albumRun(album), { text: ' • ' }, { text: duration }]),
      ],
      playlistItemData: { videoId },
      badges: explicit ? [{ musicInlineBadgeRenderer: { icon: { iconType: 'MUSIC_EXPLICIT_BADGE' } } }] : [],
    },
  };
}

export function ytmPlaylistItem({ videoId, title, artist, album, duration }) {
  return {
    musicResponsiveListItemRenderer: {
      thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`, width: 640 }] } } },
      flexColumns: [
        flex([{ text: title, navigationEndpoint: { watchEndpoint: { videoId } } }]),
        flex([artistRun(artist)]),
        flex([albumRun(album)]),
      ],
      fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: duration }] } } }],
      playlistItemData: { videoId },
    },
  };
}

export function ytmSearchResponse(songs) {
  return {
    contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
      { musicShelfRenderer: { contents: songs.map(ytmSong) } },
    ] } } } }] } },
  };
}

export function ytmPlaylistResponse({ title, items, continuation }) {
  return {
    contents: { twoColumnBrowseResultsRenderer: {
      tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicResponsiveHeaderRenderer: {
        title: { runs: [{ text: title }] },
        straplineTextOne: { runs: [{ text: 'Colas' }] },
        thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://lh3.googleusercontent.com/pl=w226-h226', width: 226 }] } } },
      } }] } } } }],
      secondaryContents: { sectionListRenderer: { contents: [{ musicPlaylistShelfRenderer: {
        contents: [
          ...items.map(ytmPlaylistItem),
          ...(continuation ? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: continuation } } } }] : []),
        ],
      } }] } },
    } },
  };
}

export function ytmContinuation(items) {
  return { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items.map(ytmPlaylistItem) } }] };
}

export function ytmLibrary(lists) {
  return {
    contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ gridRenderer: { items: [
      { musicTwoRowItemRenderer: { title: { runs: [{ text: 'Nouvelle playlist' }] }, navigationEndpoint: { createPlaylistEndpoint: {} } } },
      ...lists.map((l) => ({ musicTwoRowItemRenderer: {
        title: { runs: [{ text: l.name }] },
        subtitle: { runs: [{ text: 'Colas' }] },
        navigationEndpoint: { browseEndpoint: { browseId: `VL${l.id}` } },
        thumbnailRenderer: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://lh3.googleusercontent.com/x=w226-h226', width: 226 }] } } },
      } })),
    ] } }] } } } }] } },
  };
}

export const deezerTrack = (id, title, artist, duration) => ({
  id, type: 'track', title, title_short: title, duration, explicit_lyrics: false,
  preview: `https://cdnt-preview.dzcdn.net/${id}.mp3`, link: `https://www.deezer.com/track/${id}`,
  artist: { id: 1, name: artist }, album: { id: 2, title: 'Album', cover_medium: `https://e-cdns-images.dzcdn.net/images/cover/${id}/250x250.jpg` },
});

export const spotifyTrack = (id, name, artist, ms) => ({
  id, type: 'track', name, duration_ms: ms, explicit: false, uri: `spotify:track:${id}`, preview_url: null,
  artists: [{ name: artist }],
  album: { name: 'Album', images: [{ url: `https://i.scdn.co/image/${id}-640`, width: 640 }, { url: `https://i.scdn.co/image/${id}-300`, width: 300 }, { url: `https://i.scdn.co/image/${id}-64`, width: 64 }] },
});

// Réponse « next » (radio / file automatique) de YouTube Music
export function ytmRadioResponse(items) {
  const panel = (it) => ({
    playlistPanelVideoRenderer: {
      videoId: it.videoId,
      title: { runs: [{ text: it.title }] },
      longBylineText: { runs: [artistRun(it.artist), { text: ' • ' }, albumRun(it.album), { text: ' • ' }, { text: '2013' }] },
      shortBylineText: { runs: [{ text: it.artist }] },
      lengthText: { runs: [{ text: it.duration }] },
      thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${it.videoId}/hqdefault.jpg`, width: 480 }] },
    },
  });
  return {
    contents: { singleColumnMusicWatchNextResultsRenderer: { tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs: [{ tabRenderer: { content: { musicQueueRenderer: { content: { playlistPanelRenderer: {
      contents: items.map((it, i) => (i === 1 ? { playlistPanelVideoWrapperRenderer: { primaryRenderer: panel(it) } } : panel(it))),
    } } } } } }] } } } },
  };
}

// Accueil YouTube Music (FEmusic_home) : filtres d'ambiance, sélection rapide, cartes, suite
const twoRow = ({ title, subtitle, nav, thumb = { url: 'https://lh3.googleusercontent.com/c=w226-h226', width: 226, height: 226 } }) => ({
  musicTwoRowItemRenderer: {
    title: { runs: [{ text: title }] },
    subtitle: { runs: subtitle },
    navigationEndpoint: nav,
    thumbnailRenderer: { musicThumbnailRenderer: { thumbnail: { thumbnails: [thumb] } } },
  },
});
const browseNav = (browseId, pageType) => ({ browseEndpoint: { browseId, browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType } } } });
const carousel = (title, contents, strapline) => ({
  musicCarouselShelfRenderer: {
    header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: title }] }, ...(strapline ? { strapline: { runs: [{ text: strapline }] } } : {}) } },
    contents,
  },
});

export function ytmHomeResponse() {
  return {
    contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: {
      header: { chipCloudRenderer: { chips: ['Détente', 'Énergie', 'Pour la route'].map((t, i) => ({ chipCloudChipRenderer: { text: { runs: [{ text: t }] }, navigationEndpoint: { browseEndpoint: { browseId: 'FEmusic_home', params: `P${i}` } } } })) } },
      contents: [
        carousel('Sélection rapide', [
          ytmSong({ videoId: 'qqqqqqqqqq1', title: 'Namlunun Ucunda', artist: 'YK PRODUCTION', album: 'Namlunun Ucunda', duration: '2:58' }),
          ytmSong({ videoId: 'qqqqqqqqqq2', title: 'AÉROPORT', artist: 'Doz', album: 'DEUXIÈME DOSE', duration: '3:10' }),
        ]),
        carousel('Réécouter', [
          twoRow({ title: 'What’s luv', subtitle: [{ text: 'Titre' }, { text: ' • ' }, artistRun('Wudo Beatz')], nav: { watchEndpoint: { videoId: 'wwwwwwwwww1' } }, thumb: { url: 'https://i.ytimg.com/vi/wwwwwwwwww1/hqdefault.jpg', width: 480, height: 270 } }),
          twoRow({ title: 'Chargés comme jamais', subtitle: [{ text: 'Lolywood' }, { text: ' • ' }, { text: '10 M de vues' }], nav: { watchEndpoint: { videoId: 'wwwwwwwwww2' } }, thumb: { url: 'https://i.ytimg.com/vi/wwwwwwwwww2/hqdefault.jpg', width: 480, height: 270 } }),
        ], '13170NICO'),
        carousel('Nouveautés et classiques', [
          twoRow({ title: 'Mix découvertes', subtitle: [{ text: 'ISK, Crankdat' }], nav: browseNav('VLRDTMAK5uy_mix', 'MUSIC_PAGE_TYPE_PLAYLIST') }),
          twoRow({ title: 'Musique "J’aime"', subtitle: [{ text: 'Playlist automatique' }], nav: browseNav('VLLM', 'MUSIC_PAGE_TYPE_PLAYLIST') }),
          twoRow({ title: 'Silence Radio', subtitle: [{ text: 'Album' }, { text: ' • ' }, artistRun('La Fouine')], nav: browseNav('MPREb_album01', 'MUSIC_PAGE_TYPE_ALBUM') }),
          twoRow({ title: 'Paloma', subtitle: [{ text: 'Artiste' }], nav: browseNav('UCartist0001', 'MUSIC_PAGE_TYPE_ARTIST') }),
        ]),
      ],
      continuations: [{ nextContinuationData: { continuation: 'HOME2' } }],
    } } } }] } },
  };
}

export function ytmHomeContinuation() {
  return { continuationContents: { sectionListContinuation: { contents: [
    carousel('Favoris à redécouvrir', [twoRow({ title: 'View from the top', subtitle: [{ text: 'Titre' }, { text: ' • ' }, artistRun('Kairo')], nav: { watchEndpoint: { videoId: 'ffffffffff1' } } })]),
  ] } } };
}

export function ytmAlbumResponse() {
  return {
    contents: { twoColumnBrowseResultsRenderer: {
      tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicResponsiveHeaderRenderer: {
        title: { runs: [{ text: 'Silence Radio' }] },
        straplineTextOne: { runs: [{ text: 'La Fouine' }] },
        thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://lh3.googleusercontent.com/alb=w544-h544', width: 544 }] } } },
      } }] } } } }],
      secondaryContents: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: [
        { musicResponsiveListItemRenderer: { flexColumns: [flex([{ text: 'Catalogue', navigationEndpoint: { watchEndpoint: { videoId: 'albumtrack1' } } }])], fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: '3:21' }] } } }], playlistItemData: { videoId: 'albumtrack1' } } },
      ] } }] } },
    } },
  };
}
