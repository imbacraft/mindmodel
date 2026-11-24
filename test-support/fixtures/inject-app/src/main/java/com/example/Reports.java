package com.example;

import javax.annotation.PostConstruct;
import javax.inject.*;
import org.springframework.stereotype.Service;

// The wildcard spelling: the name does not resolve, so the simple-name fallback has to consult the catalog.
@Service
public class Reports {
  @Inject
  private Repo repo;

  @PostConstruct
  void warm() {
    repo.get(0);
  }
}
