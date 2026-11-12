# Reel Report

Statistics and patterns from your IMDb ratings, with separate views for films and TV: genres, directors, actors, franchises, studios, creators, networks, likes and dislikes, and how your scores compare with IMDb's averages.

Export your ratings from IMDb (Your ratings → ⋯ → Export), then drop the CSV on the page. The file is read in your browser and never uploaded. Actors, franchises, studios, creators and networks are looked up on [TMDB](https://www.themoviedb.org/) through a small Cloudflare Worker in `proxy/`, which holds the API key as a secret. Only IMDb title IDs are sent.

This product uses the TMDB API but is not endorsed or certified by TMDB. Not affiliated with IMDb.
