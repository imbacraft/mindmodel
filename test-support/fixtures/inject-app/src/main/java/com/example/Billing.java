package com.example;

import javax.inject.Inject;
import org.springframework.stereotype.Service;

@Service
public class Billing {
  @Inject
  private Repo repo;

  public String invoice(long id) {
    return repo.get(id);
  }
}
