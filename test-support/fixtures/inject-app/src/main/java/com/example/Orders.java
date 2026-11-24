package com.example;

import javax.inject.Inject;
import org.springframework.stereotype.Service;

@Service
public class Orders {
  @Inject
  private Repo repo;

  public String find(long id) {
    return repo.get(id);
  }
}
