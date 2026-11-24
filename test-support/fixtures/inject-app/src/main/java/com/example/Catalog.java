package com.example;

import javax.inject.Inject;
import org.springframework.stereotype.Service;

@Service
public class Catalog {
  @Inject
  private Repo repo;

  public String list() {
    return repo.get(0);
  }
}
